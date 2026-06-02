/**
 * Guarded volume service — the ONLY path that may change the NAD master volume.
 *
 * Every public method reads the *current* volume from the live NAD state, runs
 * the request through the pure guard (guard.ts), rate-limits the outbound
 * command, and logs any clamp/refusal. There is deliberately no "set arbitrary
 * dB" method that bypasses the guard (rule 9).
 *
 * G2 (never raise on its own) is structural: nothing here is called on startup,
 * reconnect, source change, or playback start — only in direct response to an
 * explicit user action routed from the HTTP layer. The single exception that may
 * *change* volume without a user action is the watchdog, and it only ever pulls
 * DOWN to the cap (never up).
 */

import { guardAbsolute, guardRelative, evaluateObserved, type VolumeGuardConfig } from './guard.js';
import type { NadClient } from '../nad/client.js';
import type { AppConfig } from '../config.js';

export interface VolumeApplyResult {
  ok: boolean;
  targetDb?: number;
  clamped?: boolean;
  reason?: string;
  note?: string;
}

export class VolumeService {
  private readonly guardCfg: VolumeGuardConfig;
  private lastSentAt = 0;

  constructor(
    private readonly nad: NadClient,
    private readonly cfg: AppConfig,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    this.guardCfg = { maxVolumeDb: cfg.maxVolumeDb, maxStepDb: cfg.maxStepDb };
  }

  /** Current volume in dB from the live NAD cache, or undefined if unknown. */
  currentDb(): number | undefined {
    const raw = this.nad.values.get('Main.Volume');
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private rateLimited(): boolean {
    // Coarse rate limit (rule 4). Date.now is fine in app runtime (not a workflow).
    const now = Date.now();
    if (now - this.lastSentAt < this.cfg.VOLUME_MIN_INTERVAL_MS) return true;
    this.lastSentAt = now;
    return false;
  }

  /** Explicit user request: set an absolute target volume (guarded). */
  setAbsolute(requestedDb: number): VolumeApplyResult {
    const current = this.currentDb();
    if (current === undefined) {
      return { ok: false, reason: 'current volume unknown (NAD not yet read)' };
    }
    const decision = guardAbsolute(requestedDb, current, this.guardCfg);
    return this.apply(decision, `setAbsolute(${requestedDb})`);
  }

  /** Explicit user request: step volume by +/- delta (guarded). */
  step(deltaDb: number): VolumeApplyResult {
    const current = this.currentDb();
    if (current === undefined) {
      return { ok: false, reason: 'current volume unknown (NAD not yet read)' };
    }
    const decision = guardRelative(deltaDb, current, this.guardCfg);
    return this.apply(decision, `step(${deltaDb})`);
  }

  private apply(
    decision: ReturnType<typeof guardAbsolute>,
    label: string,
  ): VolumeApplyResult {
    if (!decision.ok) {
      this.log('warn', `volume ${label} refused: ${decision.reason}`);
      return { ok: false, reason: decision.reason };
    }
    if (decision.note) this.log('warn', `volume ${label}: ${decision.note}`);

    if (this.rateLimited()) {
      return { ok: false, reason: 'rate-limited; try again shortly' };
    }
    try {
      this.nad.rawSetVolumeDb(decision.targetDb);
    } catch (err) {
      return { ok: false, reason: `send failed: ${(err as Error).message}` };
    }
    this.log('info', `volume ${label} -> ${decision.targetDb} dB`);
    return {
      ok: true,
      targetDb: decision.targetDb,
      clamped: decision.clamped,
      note: decision.note,
    };
  }

  /**
   * Evaluate an OBSERVED volume (startup/reconnect/watchdog). Never raises.
   * Returns whether it is over the cap, and — if enabled — pulls it down.
   *
   * @param trigger 'startup' uses CLAMP_ON_OBSERVED; 'watchdog' uses VOLUME_WATCHDOG.
   */
  reconcileObserved(trigger: 'startup' | 'watchdog'): { overCap: boolean; clamped: boolean } {
    const current = this.currentDb();
    if (current === undefined) return { overCap: false, clamped: false };

    const { overCap, clampTo } = evaluateObserved(current, this.guardCfg);
    if (!overCap) return { overCap: false, clamped: false };

    const enabled = trigger === 'watchdog' ? this.cfg.VOLUME_WATCHDOG : this.cfg.CLAMP_ON_OBSERVED;
    this.log(
      'warn',
      `observed volume ${current} dB is ABOVE cap ${this.cfg.maxVolumeDb} dB (${trigger}).` +
        (enabled ? ` Clamping down to ${clampTo} dB.` : ' Raising UI alert only (clamp disabled).'),
    );

    if (!enabled) return { overCap: true, clamped: false };
    if (this.rateLimited()) return { overCap: true, clamped: false };
    try {
      this.nad.rawSetVolumeDb(clampTo);
      return { overCap: true, clamped: true };
    } catch {
      return { overCap: true, clamped: false };
    }
  }
}
