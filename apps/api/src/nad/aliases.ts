/**
 * Key-name aliases between firmware generations on the shared V2.x protocol.
 *
 * The app speaks the newer (V3 / MDC) vocabulary. The first-generation T-series
 * (the published 2012 command lists) sometimes names the SAME feature
 * differently. Only TRUE synonyms belong here — features that genuinely do not
 * exist on a generation are handled by capability discovery (greyed out in the
 * UI), never aliased.
 *
 * Verified against the 2012 command lists:
 *   - `Tuner.FM.Preset` (V3)  ==  `Tuner.Preset` (first-gen, Range 1-40)
 *
 * NOT aliased — different feature despite a similar name:
 *   - `Main.AutoStandby` (auto power-off timer) is NOT `Main.ControlStandby`
 *     ("allow Ethernet control while in standby"). First-gen has no auto-standby.
 */

/** canonical key (what the app uses) → [canonical, ...older synonyms]. */
export const KEY_ALIASES: Record<string, string[]> = {
  'Tuner.FM.Preset': ['Tuner.FM.Preset', 'Tuner.Preset'],
};

/**
 * The key to actually write/read for `canonical`: the first alias the device
 * has already reported a value for, else the canonical key itself (so V3 and
 * the pre-discovery state both use the modern name).
 */
export function resolveKey(values: Map<string, string>, canonical: string): string {
  const aliases = KEY_ALIASES[canonical];
  if (!aliases) return canonical;
  for (const a of aliases) if (values.has(a)) return a;
  return canonical;
}

/** Value for `canonical`, looking through every alias. */
export function getAliased(values: Map<string, string>, canonical: string): string | undefined {
  for (const a of KEY_ALIASES[canonical] ?? [canonical]) {
    const v = values.get(a);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Expand a list of canonical keys to include all alias spellings (deduped). */
export function expandAliases(keys: string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    out.add(k);
    for (const a of KEY_ALIASES[k] ?? []) out.add(a);
  }
  return [...out];
}
