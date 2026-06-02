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

export type VolumeChannel = 'main' | 'zone2';

export class VolumeService {
  private readonly guardCfg: Record<VolumeChannel, VolumeGuardConfig>;
  private readonly lastSentAt: Record<VolumeChannel, number> = { main: 0, zone2: 0 };

  constructor(
    private readonly nad: NadClient,
    private readonly cfg: AppConfig,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    // Each channel has its OWN cap/step. G1 ("app can never command a volume
    // above the cap") holds per-channel; Zone 2 never falls back to uncapped
    // (config resolves zone2MaxVolumeDb to the Main cap when unset).
    this.guardCfg = {
      main: { maxVolumeDb: cfg.maxVolumeDb, maxStepDb: cfg.maxStepDb },
      zone2: { maxVolumeDb: cfg.zone2MaxVolumeDb, maxStepDb: cfg.zone2MaxStepDb },
    };
  }

  private key(channel: VolumeChannel): string {
    return channel === 'zone2' ? 'Zone2.Volume' : 'Main.Volume';
  }

  /** Current volume in dB for a channel from the live NAD cache. */
  currentDb(channel: VolumeChannel = 'main'): number | undefined {
    const raw = this.nad.values.get(this.key(channel));
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private rawSet(channel: VolumeChannel, db: number): void {
    if (channel === 'zone2') this.nad.rawSetZone2VolumeDb(db);
    else this.nad.rawSetVolumeDb(db);
  }

  private rateLimited(channel: VolumeChannel): boolean {
    // Coarse rate limit (rule 4). Date.now is fine in app runtime (not a workflow).
    const now = Date.now();
    if (now - this.lastSentAt[channel] < this.cfg.VOLUME_MIN_INTERVAL_MS) return true;
    this.lastSentAt[channel] = now;
    return false;
  }

  /** Explicit user request: set an absolute target volume (guarded). */
  setAbsolute(requestedDb: number, channel: VolumeChannel = 'main'): VolumeApplyResult {
    const current = this.currentDb(channel);
    if (current === undefined) {
      return { ok: false, reason: `current ${channel} volume unknown (NAD not yet read)` };
    }
    const decision = guardAbsolute(requestedDb, current, this.guardCfg[channel]);
    return this.apply(channel, decision, `${channel} setAbsolute(${requestedDb})`);
  }

  /** Explicit user request: step volume by +/- delta (guarded). */
  step(deltaDb: number, channel: VolumeChannel = 'main'): VolumeApplyResult {
    const current = this.currentDb(channel);
    if (current === undefined) {
      return { ok: false, reason: `current ${channel} volume unknown (NAD not yet read)` };
    }
    const decision = guardRelative(deltaDb, current, this.guardCfg[channel]);
    return this.apply(channel, decision, `${channel} step(${deltaDb})`);
  }

  private apply(
    channel: VolumeChannel,
    decision: ReturnType<typeof guardAbsolute>,
    label: string,
  ): VolumeApplyResult {
    if (!decision.ok) {
      this.log('warn', `volume ${label} refused: ${decision.reason}`);
      return { ok: false, reason: decision.reason };
    }
    if (decision.note) this.log('warn', `volume ${label}: ${decision.note}`);

    if (this.rateLimited(channel)) {
      return { ok: false, reason: 'rate-limited; try again shortly' };
    }
    try {
      this.rawSet(channel, decision.targetDb);
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

    const { overCap, clampTo } = evaluateObserved(current, this.guardCfg.main);
    if (!overCap) return { overCap: false, clamped: false };

    const enabled = trigger === 'watchdog' ? this.cfg.VOLUME_WATCHDOG : this.cfg.CLAMP_ON_OBSERVED;
    this.log(
      'warn',
      `observed volume ${current} dB is ABOVE cap ${this.cfg.maxVolumeDb} dB (${trigger}).` +
        (enabled ? ` Clamping down to ${clampTo} dB.` : ' Raising UI alert only (clamp disabled).'),
    );

    if (!enabled) return { overCap: true, clamped: false };
    if (this.rateLimited('main')) return { overCap: true, clamped: false };
    try {
      this.nad.rawSetVolumeDb(clampTo);
      return { overCap: true, clamped: true };
    } catch {
      return { overCap: true, clamped: false };
    }
  }
}
