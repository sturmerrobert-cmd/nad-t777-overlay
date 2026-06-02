import { describe, it, expect } from 'vitest';
import { guardAbsolute, guardRelative, evaluateObserved, type VolumeGuardConfig } from './guard.js';

// Mirrors the confirmed config: cap -30 dB, max single step 5 dB.
const cfg: VolumeGuardConfig = { maxVolumeDb: -30, maxStepDb: 5 };

describe('guardAbsolute', () => {
  it('allows a small move below the cap', () => {
    const r = guardAbsolute(-34, -36, cfg);
    expect(r).toMatchObject({ ok: true, targetDb: -34, clamped: false });
  });

  it('allows landing exactly at the cap', () => {
    const r = guardAbsolute(-30, -34, cfg); // 4 dB move, lands on cap
    expect(r).toMatchObject({ ok: true, targetDb: -30, clamped: false });
  });

  it('clamps a request above the cap down to the cap (G1)', () => {
    // From -33, requesting -29 (above cap -30): clamp to -30, a 3 dB move → allowed.
    const r = guardAbsolute(-29, -33, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetDb).toBe(-30);
      expect(r.clamped).toBe(true);
      expect(r.note).toContain('clamped');
    }
  });

  it('never honors an above-cap request as-is, even far above', () => {
    const r = guardAbsolute(0, -30, cfg); // wildly loud request
    // clamp to -30 first (0 move) → allowed but clamped, NOT set to 0
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetDb).toBe(-30);
  });

  it('rejects a single jump larger than the step, even toward a legal target', () => {
    // -56 → -45 is a legal level (below cap) but an 11 dB jump in one command.
    const r = guardAbsolute(-45, -56, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('step too large');
  });

  it('rejects a big jump that is ALSO above the cap (clamp-then-step still blocks)', () => {
    // From -56, requesting +6 dB: clamp to -30, but -56→-30 = 26 dB ≫ step → reject.
    const r = guardAbsolute(6, -56, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('step too large');
  });

  it('allows turning down by a small step', () => {
    const r = guardAbsolute(-60, -56, cfg);
    expect(r).toMatchObject({ ok: true, targetDb: -60, clamped: false });
  });

  it('rejects non-finite input', () => {
    expect(guardAbsolute(Number.NaN, -50, cfg).ok).toBe(false);
    expect(guardAbsolute(Number.POSITIVE_INFINITY, -50, cfg).ok).toBe(false);
  });
});

describe('guardRelative', () => {
  it('allows a small positive step below the cap', () => {
    const r = guardRelative(+4, -50, cfg);
    expect(r).toMatchObject({ ok: true, targetDb: -46, clamped: false });
  });

  it('allows a negative step (turning down) without clamping', () => {
    const r = guardRelative(-5, -50, cfg);
    expect(r).toMatchObject({ ok: true, targetDb: -55, clamped: false });
  });

  it('clamps a step that would cross the cap, landing on the cap (G1)', () => {
    // From -33, +5 would reach -28 (above cap -30) → clamp to -30.
    const r = guardRelative(+5, -33, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetDb).toBe(-30);
      expect(r.clamped).toBe(true);
    }
  });

  it('rejects a step magnitude larger than MAX_STEP_DB (positive)', () => {
    const r = guardRelative(+6, -50, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('step too large');
  });

  it('rejects a step magnitude larger than MAX_STEP_DB (negative)', () => {
    const r = guardRelative(-6, -50, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('step too large');
  });

  it('allows a step that lands exactly on the cap without clamping flag', () => {
    const r = guardRelative(+4, -34, cfg); // -34 + 4 = -30, exactly cap
    expect(r).toMatchObject({ ok: true, targetDb: -30, clamped: false });
  });

  it('handles fractional accumulation without float drift', () => {
    const r = guardRelative(+0.5, -50.0, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetDb).toBe(-49.5);
  });

  it('rejects non-finite delta', () => {
    expect(guardRelative(Number.NaN, -50, cfg).ok).toBe(false);
  });
});

describe('independent channel cap (e.g. Zone 2 with its own cap)', () => {
  // Zone 2 can carry a different cap than Main; the pure guard just takes a cfg.
  const z2: VolumeGuardConfig = { maxVolumeDb: -15, maxStepDb: 5 };

  it('clamps a Zone 2 set to the Zone 2 cap, not the Main cap', () => {
    const r = guardAbsolute(-12, -17, z2); // above -15 cap, 5 dB move from -17
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetDb).toBe(-15);
      expect(r.clamped).toBe(true);
    }
  });

  it('allows a Zone 2 level that would be over the stricter Main cap', () => {
    const r = guardAbsolute(-18, -20, z2); // -18 is above Main -30 but below Zone 2 -15
    expect(r).toMatchObject({ ok: true, targetDb: -18, clamped: false });
  });

  it('flags Zone 2 over its own cap independently', () => {
    expect(evaluateObserved(-10, z2)).toEqual({ overCap: true, clampTo: -15 });
    expect(evaluateObserved(-20, z2)).toEqual({ overCap: false, clampTo: -20 });
  });
});

describe('evaluateObserved', () => {
  it('flags an observed volume above the cap and proposes pulling down to the cap', () => {
    expect(evaluateObserved(-20, cfg)).toEqual({ overCap: true, clampTo: -30 });
  });

  it('does not flag a volume at the cap', () => {
    expect(evaluateObserved(-30, cfg)).toEqual({ overCap: false, clampTo: -30 });
  });

  it('does not flag a volume below the cap', () => {
    expect(evaluateObserved(-56, cfg)).toEqual({ overCap: false, clampTo: -56 });
  });
});
