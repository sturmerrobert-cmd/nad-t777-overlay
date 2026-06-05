/**
 * Allowlisted device settings (everything EXCEPT volume).
 *
 * Volume must only ever change through the guarded VolumeService. This module is
 * the generic path for all *other* settings (tone, speakers, surround, CEC, …).
 * As a hard backstop, applySetting/stepSetting refuse any key containing
 * "Volume" — so this can never be used to bypass the volume guard (rule 9).
 */

import type { NadClient } from './nad/client.js';

export type SettingSpec =
  | { kind: 'toggle' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'int'; min: number; max: number; step: number; unit?: string };

/** key → spec. Only keys listed here may be set. No "Volume" keys allowed. */
export const SETTINGS: Record<string, SettingSpec> = {
  // Tone
  'Main.Bass': { kind: 'int', min: -10, max: 10, step: 1, unit: 'dB' },
  'Main.Treble': { kind: 'int', min: -10, max: 10, step: 1, unit: 'dB' },
  'Main.ToneDefeat': { kind: 'toggle' },
  // Bass management / levels
  'Main.Speaker.Sub': { kind: 'toggle' },
  'Main.EnhancedBass': { kind: 'toggle' },
  'Main.Level.Center': { kind: 'int', min: -12, max: 12, step: 1, unit: 'dB' },
  'Main.Level.Sub': { kind: 'int', min: -12, max: 12, step: 1, unit: 'dB' },
  'Main.CenterDialog': { kind: 'int', min: 0, max: 6, step: 1 },
  // Speaker size
  'Main.Speaker.Front.Config': { kind: 'enum', options: ['Large', 'Small'] },
  'Main.Speaker.Center.Config': { kind: 'enum', options: ['Large', 'Small'] },
  'Main.Speaker.Surround.Config': { kind: 'enum', options: ['Large', 'Small'] },
  // Surround params (booleans we’re confident about)
  'Main.Dolby.Panorama': { kind: 'toggle' },
  'Main.Dolby.CenterSpread': { kind: 'toggle' },
  // System
  'Main.AutoStandby': { kind: 'toggle' },
  'Main.OSD.TempDisplay': { kind: 'toggle' },
  'Main.CEC.Audio': { kind: 'toggle' },
  'Main.CEC.Switch': { kind: 'toggle' },
  'Main.CEC.Power': { kind: 'toggle' },
  // On T 777 V3, ARC is auto-negotiated: `Main.CEC.ARC=On` does NOT persist
  // (reverts to Off), so only Auto (engage when the TV requests it) and Off are
  // meaningful. Exposing "On" would be a confusing no-op.
  'Main.CEC.ARC': { kind: 'enum', options: ['Auto', 'Off'] },
  // Zone 2 output mode (volume itself stays guarded via VolumeService)
  'Zone2.VolumeControl': { kind: 'enum', options: ['Variable', 'Fixed'] },
};

export interface SettingResult {
  ok: boolean;
  error?: string;
  value?: string;
}

function guardKey(key: string): string | null {
  if (/volume/i.test(key)) {
    return `refused: "${key}" is a volume key — volume only changes through the guarded service`;
  }
  if (!(key in SETTINGS)) return `unknown/not-allowlisted setting: "${key}"`;
  return null;
}

/** Set an absolute value for an allowlisted setting. */
export function applySetting(nad: NadClient, key: string, value: string | boolean): SettingResult {
  const err = guardKey(key);
  if (err) return { ok: false, error: err };
  const spec = SETTINGS[key]!;

  let out: string;
  if (spec.kind === 'toggle') {
    const on = value === true || value === 'On' || value === 'on' || value === '1';
    out = on ? 'On' : 'Off';
  } else if (spec.kind === 'enum') {
    out = String(value);
    if (!spec.options.includes(out)) return { ok: false, error: `value must be one of ${spec.options.join('/')}` };
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'value must be numeric' };
    const clamped = Math.max(spec.min, Math.min(spec.max, Math.round(n)));
    out = String(clamped);
  }

  try {
    nad.setSetting(key, out);
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Step a numeric setting by +/- delta, reading current from the live cache. */
export function stepSetting(nad: NadClient, key: string, delta: number): SettingResult {
  const err = guardKey(key);
  if (err) return { ok: false, error: err };
  const spec = SETTINGS[key]!;
  if (spec.kind !== 'int') return { ok: false, error: `"${key}" is not a numeric setting` };

  const cur = Number(nad.values.get(key));
  if (!Number.isFinite(cur)) return { ok: false, error: 'current value unknown (not yet read)' };
  const next = Math.max(spec.min, Math.min(spec.max, cur + delta));
  try {
    nad.setSetting(key, String(next));
    return { ok: true, value: String(next) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
