/**
 * Environment configuration, validated at startup.
 *
 * MAX_VOLUME_DB is REQUIRED and has NO default: the backend refuses to start if
 * it is unset (volume-safety rule 1 — no silent default). Everything else has a
 * safe default. Booleans default to the conservative/off setting.
 */

import { z } from 'zod';

/** Required finite number — rejects undefined and empty string (no silent default). */
const requiredNum = (msg: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
    z.number({ invalid_type_error: msg, required_error: msg }).finite(msg),
  );

/** Optional finite number with a default applied when unset/empty. */
const numDefault = (d: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? d : typeof v === 'string' ? Number(v) : v),
    z.number().finite(),
  );

/** Optional finite number (undefined when unset/empty). */
const numOptional = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : typeof v === 'string' ? Number(v) : v),
  z.number().finite().optional(),
);

/** Coerce "true"/"1"/"yes"/"on" → true; everything else → the given default. */
const boolDefault = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v).trim())),
    z.boolean(),
  );

const schema = z.object({
  DEVICE_IP: z.string().trim().min(1, 'DEVICE_IP is required (explicit LAN IP, not .local)'),

  // REQUIRED hard ceiling — no default. Backend will not start without it.
  MAX_VOLUME_DB: requiredNum('MAX_VOLUME_DB is required and must be a finite number'),

  MAX_STEP_DB: numDefault(5),
  // UI confirm threshold (below the cap). Optional.
  WARN_VOLUME_DB: numOptional,
  // UI-only initial slider position; never sent automatically.
  DEFAULT_VOLUME_DB: numOptional,

  // If true, pull an observed over-cap volume down to the cap at startup/reconnect.
  CLAMP_ON_OBSERVED: boolDefault(false),
  // If true, continuously poll and clamp over-cap volume from ANY source
  // (overrides the physical remote/knob — that is why it defaults off).
  VOLUME_WATCHDOG: boolDefault(false),

  NAD_PORT: numDefault(23),
  BLUOS_PORT: numDefault(11000),
  HTTP_PORT: numDefault(8787),
  POLL_INTERVAL_MS: numDefault(1500),
  // Min gap between outbound volume commands (rate limit, rule 4).
  VOLUME_MIN_INTERVAL_MS: numDefault(150),
});

export type AppConfig = z.infer<typeof schema> & {
  maxVolumeDb: number;
  maxStepDb: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    const missingCap = parsed.error.issues.some((i) => i.path[0] === 'MAX_VOLUME_DB');
    throw new Error(
      `Invalid configuration — backend refuses to start:\n${issues}` +
        (missingCap
          ? `\n\nMAX_VOLUME_DB is the required, non-bypassable volume ceiling and has NO default.\n` +
            `Set it in .env, e.g.  MAX_VOLUME_DB=-30`
          : ''),
    );
  }

  const cfg = parsed.data;

  // Sanity: WARN should be below the cap if provided.
  if (cfg.WARN_VOLUME_DB !== undefined && cfg.WARN_VOLUME_DB > cfg.MAX_VOLUME_DB) {
    throw new Error(
      `WARN_VOLUME_DB (${cfg.WARN_VOLUME_DB}) must be <= MAX_VOLUME_DB (${cfg.MAX_VOLUME_DB}).`,
    );
  }

  return {
    ...cfg,
    // Convenient aliases for the guard.
    maxVolumeDb: cfg.MAX_VOLUME_DB,
    maxStepDb: cfg.MAX_STEP_DB,
  };
}
