/**
 * Track-list capture — records the DISTINCT tracks that played, as metadata only
 * (title / artist / album / service / time). This is a "shopping list" of what
 * you heard, so you can find or buy it legally. It never captures or stores any
 * audio — only the text the streamer already reports in now-playing.
 *
 * Distinct tracks (deduped by artist+title) are appended to a JSONL file so the
 * list survives restarts; replays bump an in-memory play count.
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NowPlaying } from '../types.js';
import type { TrackEntry } from '../types.js';

const MAX_KEPT = 5000;

export class TrackLogger {
  private tracks: TrackEntry[] = []; // most recent first
  private seen = new Map<string, TrackEntry>();
  private lastKey: string | null = null;
  private ready: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    this.ready = this.load();
  }

  private key(artist: string | undefined, title: string): string {
    return `${(artist ?? '').toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as TrackEntry;
        const k = this.key(e.artist, e.title);
        if (!this.seen.has(k)) {
          this.seen.set(k, e);
          this.tracks.unshift(e);
        }
      }
      if (this.tracks.length > MAX_KEPT) this.tracks.length = MAX_KEPT;
      this.log('info', `tracklist: loaded ${this.tracks.length} captured tracks`);
    } catch {
      /* no file yet */
    }
  }

  /** Observe one now-playing snapshot (once per poll). */
  observe(np: NowPlaying, at: number): void {
    const title = np.title?.trim();
    // Only real, currently-playing tracks. Skips "External Source"/stopped/paused.
    if (!title || !/^(play|stream)/i.test(np.state ?? '')) return;
    // Ignore non-track placeholders.
    if (/^external source$/i.test(title)) return;

    const k = this.key(np.artist, title);
    if (k === this.lastKey) return; // same track still playing
    this.lastKey = k;

    const existing = this.seen.get(k);
    if (existing) {
      existing.plays += 1;
      existing.lastSeen = at;
      return; // counts are in-memory; the entry is already persisted
    }
    const entry: TrackEntry = {
      title,
      artist: np.artist?.trim() || undefined,
      album: np.album?.trim() || undefined,
      service: np.service?.trim() || undefined,
      firstSeen: at,
      lastSeen: at,
      plays: 1,
    };
    this.seen.set(k, entry);
    this.tracks.unshift(entry);
    if (this.tracks.length > MAX_KEPT) this.tracks.length = MAX_KEPT;
    void this.append(entry);
    this.log('info', `tracklist: captured "${entry.title}"${entry.artist ? ` — ${entry.artist}` : ''}`);
  }

  private async append(entry: TrackEntry): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      this.log('warn', `tracklist: append failed: ${(e as Error).message}`);
    }
  }

  list(limit = 1000): TrackEntry[] {
    return this.tracks.slice(0, limit);
  }

  /** CSV for download (spreadsheet-friendly). */
  toCsv(): string {
    const esc = (s: string | number | undefined) => {
      const v = s === undefined ? '' : String(s);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const rows = [['Title', 'Artist', 'Album', 'Service', 'Plays', 'First heard', 'Last heard']];
    for (const t of this.tracks) {
      rows.push([
        esc(t.title),
        esc(t.artist),
        esc(t.album),
        esc(t.service),
        esc(t.plays),
        esc(new Date(t.firstSeen).toISOString()),
        esc(new Date(t.lastSeen).toISOString()),
      ]);
    }
    return rows.map((r) => r.join(',')).join('\n');
  }

  async clear(): Promise<void> {
    this.tracks = [];
    this.seen.clear();
    this.lastKey = null;
    try {
      await writeFile(this.file, '', 'utf8');
    } catch {
      /* ignore */
    }
  }
}
