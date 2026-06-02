/**
 * Usage logger — derives a log of "what was playing, for how long, how loud"
 * purely from polling. Each segment is a continuous stretch on one source while
 * the receiver is powered on; volume is sampled each poll into min/avg/max/last.
 *
 * Finalized segments are appended to a JSONL file so history survives restarts.
 * The open (current) segment lives in memory until the source changes or power
 * goes off.
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageLog, UsageSegment } from '../types.js';

interface OpenSegment {
  source: number;
  sourceName: string;
  startedAt: number;
  lastAt: number;
  samples: number;
  volSum: number;
  volMin?: number;
  volMax?: number;
  volLast?: number;
}

const MAX_KEPT = 1000;

export class UsageLogger {
  private open: OpenSegment | null = null;
  private recent: UsageSegment[] = []; // most recent first
  private ready: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8');
      const segs = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as UsageSegment);
      this.recent = segs.reverse().slice(0, MAX_KEPT);
      this.log('info', `usage log: loaded ${this.recent.length} past segments`);
    } catch {
      this.recent = []; // no file yet
    }
  }

  /**
   * Record one poll observation. Called once per poll cycle.
   * @param at epoch ms of this observation (caller passes Date.now()).
   */
  observe(
    power: string | undefined,
    source: number | undefined,
    sourceName: string,
    volumeDb: number | undefined,
    at: number,
  ): void {
    const active = power === 'On' && source !== undefined;

    if (!active) {
      void this.closeOpen(at);
      return;
    }

    if (!this.open || this.open.source !== source) {
      void this.closeOpen(at);
      this.open = {
        source: source!,
        sourceName,
        startedAt: at,
        lastAt: at,
        samples: 0,
        volSum: 0,
      };
    }

    const o = this.open;
    o.sourceName = sourceName; // keep latest label
    o.lastAt = at;
    if (volumeDb !== undefined) {
      o.samples += 1;
      o.volSum += volumeDb;
      o.volMin = o.volMin === undefined ? volumeDb : Math.min(o.volMin, volumeDb);
      o.volMax = o.volMax === undefined ? volumeDb : Math.max(o.volMax, volumeDb);
      o.volLast = volumeDb;
    }
  }

  private toSegment(o: OpenSegment, open: boolean): UsageSegment {
    const round1 = (n?: number) => (n === undefined ? undefined : Math.round(n * 10) / 10);
    return {
      source: o.source,
      sourceName: o.sourceName,
      startedAt: o.startedAt,
      endedAt: o.lastAt,
      durationSec: Math.max(0, Math.round((o.lastAt - o.startedAt) / 1000)),
      volMinDb: round1(o.volMin),
      volMaxDb: round1(o.volMax),
      volAvgDb: o.samples > 0 ? round1(o.volSum / o.samples) : undefined,
      volLastDb: round1(o.volLast),
      samples: o.samples,
      open,
    };
  }

  /** Finalize and persist the open segment, if any. */
  private async closeOpen(at: number): Promise<void> {
    if (!this.open) return;
    this.open.lastAt = Math.max(this.open.lastAt, at);
    // Drop trivial blips (< 1 poll of real duration with no samples).
    const seg = this.toSegment(this.open, false);
    this.open = null;
    if (seg.durationSec <= 0 && seg.samples <= 1) return;

    this.recent.unshift(seg);
    if (this.recent.length > MAX_KEPT) this.recent.length = MAX_KEPT;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(seg) + '\n', 'utf8');
    } catch (e) {
      this.log('warn', `usage log: append failed: ${(e as Error).message}`);
    }
  }

  /** Current snapshot: open segment (live) + recent finalized segments. */
  getLog(limit = 200): UsageLog {
    const current = this.open ? this.toSegment(this.open, true) : null;
    return { current, segments: this.recent.slice(0, limit) };
  }

  async clear(): Promise<void> {
    this.open = null;
    this.recent = [];
    try {
      await writeFile(this.file, '', 'utf8');
    } catch {
      /* ignore */
    }
  }
}
