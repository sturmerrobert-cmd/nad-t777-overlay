/**
 * Volume safety guard — the single most safety-critical module in the app.
 *
 * Pure, side-effect-free decision functions. They never touch the network; they
 * only decide what (if anything) is a safe target volume. The guarded service
 * (service.ts) is the ONLY caller allowed to actually send a volume to the NAD,
 * and it MUST route every change through here.
 *
 * Two guarantees this enforces (server-side, non-bypassable by the UI):
 *   G1: the app can never command a volume above `maxVolumeDb`.
 *   G2: the app never raises volume on its own — these functions only ever react
 *       to an explicit user request; nothing here is called automatically, and
 *       no function returns a target higher than what the user asked for.
 *
 * dB convention: louder = higher dB. `maxVolumeDb` is an UPPER bound (a ceiling).
 */

export interface VolumeGuardConfig {
  /** Hard ceiling. No command may ever set a volume above this. */
  maxVolumeDb: number;
  /** Max absolute delta from current volume allowed in a single command. */
  maxStepDb: number;
}

export type GuardDecision =
  | {
      ok: true;
      /** The volume to actually send (already clamped to the ceiling). */
      targetDb: number;
      /** True if the request was above the ceiling and was pulled down. */
      clamped: boolean;
      /** Human-readable note for logging (warnings on clamp). */
      note?: string;
    }
  | {
      ok: false;
      /** Why the command was refused. The current volume is left untouched. */
      reason: string;
    };

/** Round to 1 decimal to avoid float noise from repeated additions. */
function norm(db: number): number {
  return Math.round(db * 10) / 10;
}

/**
 * Guard an ABSOLUTE set request ("set volume to X dB").
 *
 * - Clamps X down to the ceiling (G1). A request above the ceiling is honored
 *   only as the clamped value, never as-is, and flagged so the caller can warn.
 * - Then refuses if the resulting move from `currentDb` exceeds `maxStepDb`
 *   (rule 4: a UI bug must not jump volume in one shot). The clamp happens first,
 *   so even a wildly-too-high request can't sneak past the step check.
 */
export function guardAbsolute(
  requestedDb: number,
  currentDb: number,
  cfg: VolumeGuardConfig,
): GuardDecision {
  if (!Number.isFinite(requestedDb)) {
    return { ok: false, reason: `non-finite requested volume: ${requestedDb}` };
  }
  const ceiling = cfg.maxVolumeDb;
  const target = norm(Math.min(requestedDb, ceiling));
  const clamped = requestedDb > ceiling;

  const delta = Math.abs(target - currentDb);
  if (delta > cfg.maxStepDb + 1e-9) {
    return {
      ok: false,
      reason:
        `step too large: |${norm(target)} - ${norm(currentDb)}| = ${norm(delta)} dB ` +
        `exceeds MAX_STEP_DB ${cfg.maxStepDb} dB`,
    };
  }

  return {
    ok: true,
    targetDb: target,
    clamped,
    note: clamped
      ? `requested ${norm(requestedDb)} dB above cap ${ceiling} dB — clamped to ${target} dB`
      : undefined,
  };
}

/**
 * Guard a RELATIVE step request ("change volume by +/- delta dB"), e.g. the NAD
 * `Main.Volume+` / `Main.Volume-` family. Never forwarded blindly:
 *
 * - Refuses if the step magnitude itself exceeds `maxStepDb` (rule 4).
 * - Computes the target and clamps it to the ceiling (G1, rule 3). A step that
 *   would cross the ceiling lands exactly on it and is flagged as clamped.
 * - Negative deltas (turning down) are always safe w.r.t. the ceiling.
 */
export function guardRelative(
  deltaDb: number,
  currentDb: number,
  cfg: VolumeGuardConfig,
): GuardDecision {
  if (!Number.isFinite(deltaDb)) {
    return { ok: false, reason: `non-finite delta: ${deltaDb}` };
  }
  if (Math.abs(deltaDb) > cfg.maxStepDb + 1e-9) {
    return {
      ok: false,
      reason: `step too large: |${norm(deltaDb)}| dB exceeds MAX_STEP_DB ${cfg.maxStepDb} dB`,
    };
  }

  const raw = currentDb + deltaDb;
  const target = norm(Math.min(raw, cfg.maxVolumeDb));
  const clamped = raw > cfg.maxVolumeDb;

  return {
    ok: true,
    targetDb: target,
    clamped,
    note: clamped
      ? `step from ${norm(currentDb)} by ${norm(deltaDb)} dB would reach ${norm(raw)} dB ` +
        `above cap ${cfg.maxVolumeDb} dB — clamped to ${target} dB`
      : undefined,
  };
}

/**
 * Decide what to do about an OBSERVED volume at startup/reconnect or from the
 * watchdog poll. This never raises volume; it only ever proposes pulling DOWN to
 * the ceiling, and only when explicitly enabled.
 *
 * Returns:
 *  - `{ overCap: false }` when the observed volume is at/below the ceiling.
 *  - `{ overCap: true, clampTo }` when above the ceiling. `clampTo` is the
 *    ceiling; the caller pulls down only if CLAMP_ON_OBSERVED / VOLUME_WATCHDOG
 *    is enabled, otherwise it just raises a UI alert.
 */
export function evaluateObserved(
  observedDb: number,
  cfg: VolumeGuardConfig,
): { overCap: boolean; clampTo: number } {
  return observedDb > cfg.maxVolumeDb
    ? { overCap: true, clampTo: cfg.maxVolumeDb }
    : { overCap: false, clampTo: observedDb };
}
