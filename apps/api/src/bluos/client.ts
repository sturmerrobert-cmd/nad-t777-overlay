/**
 * BluOS client (HTTP GET, port 11000, UTF-8 XML).
 *
 * Used read-mostly: now-playing from /Status, sync/volume from /SyncStatus,
 * plus presets and transport. The BluOS /Volume path is also clamped by the
 * guarded service; primary volume enforcement is the NAD master volume.
 */

import { XMLParser } from 'fast-xml-parser';
import type { BrowseItem, BrowseResult, NowPlaying, QueueItem } from '../types.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export interface BluOSClientOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export class BluOSClient {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts: BluOSClientOptions) {
    this.base = `http://${opts.host}:${opts.port}`;
    // Short timeout: BluOS's HTTP server can hang while the receiver is fine;
    // fail fast so polling/commands degrade gracefully instead of stalling.
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  private async get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`); // don't parse 404/error pages as data
      const text = await res.text();
      return parser.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Combined now-playing snapshot from /Status (+ /SyncStatus volume). */
  async getNowPlaying(): Promise<NowPlaying> {
    try {
      const [statusDoc, syncDoc] = await Promise.all([
        this.get('/Status').catch(() => null),
        this.get('/SyncStatus').catch(() => null),
      ]);

      const status = (statusDoc as Record<string, any> | null)?.status ?? {};
      const sync = (syncDoc as Record<string, any> | null)?.SyncStatus ?? {};

      const num = (v: unknown): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      const image = status.image as string | undefined;

      return {
        reachable: statusDoc !== null || syncDoc !== null,
        state: status.state,
        title: status.title1 ?? status.name,
        artist: status.title2 ?? status.artist,
        album: status.title3 ?? status.album,
        imageUrl: image ? (image.startsWith('http') ? image : this.base + image) : undefined,
        service: status.service,
        quality: status.quality,
        bluosVolume: num(status.volume ?? sync['@_volume']),
        bluosDb: num(status.db ?? sync['@_db']),
      };
    } catch {
      return { reachable: false };
    }
  }

  /** List presets: [{ id, name, url? }]. */
  async getPresets(): Promise<Array<{ id: number; name: string; url?: string }>> {
    try {
      const doc = (await this.get('/Presets')) as Record<string, any>;
      const raw = doc?.presets?.preset;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return list
        .map((p: any) => ({
          id: Number(p['@_id']),
          name: String(p['@_name'] ?? `Preset ${p['@_id']}`),
          url: p['@_url'],
        }))
        .filter((p) => Number.isFinite(p.id));
    } catch {
      return [];
    }
  }

  loadPreset(id: number): Promise<unknown> {
    return this.get(`/Preset?id=${encodeURIComponent(id)}`);
  }

  play(): Promise<unknown> {
    return this.get('/Play');
  }
  pause(): Promise<unknown> {
    return this.get('/Pause');
  }
  skip(): Promise<unknown> {
    return this.get('/Skip');
  }
  back(): Promise<unknown> {
    return this.get('/Back');
  }

  /** Set BluOS volume on the 0-100 scale (already clamp-decided by the service). */
  setVolumePercent(level: number): Promise<unknown> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    return this.get(`/Volume?level=${clamped}`);
  }

  /**
   * Browse the BluOS menu tree (services, radio, playlists, local library).
   * Same navigation the BluOS app uses. `key` is an item's browseKey; omit for
   * the root menu.
   */
  async browse(key?: string): Promise<BrowseResult> {
    try {
      const path = key ? `/Browse?key=${encodeURIComponent(key)}` : '/Browse';
      const doc = (await this.get(path)) as Record<string, any>;
      const b = doc?.browse ?? {};
      const items: BrowseItem[] = [];
      // Items may sit directly under <browse> or be grouped in <category>.
      const collect = (raw: any) => {
        const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const it of arr) {
          const text = it['@_text'] ?? it['@_title'];
          if (text === undefined) continue;
          items.push({
            text: String(text),
            type: it['@_type'],
            browseKey: it['@_browseKey'],
            playURL: it['@_playURL'],
            image: it['@_image'],
          });
        }
      };
      collect(b.item);
      const cats = Array.isArray(b.category) ? b.category : b.category ? [b.category] : [];
      for (const c of cats) collect(c.item);
      return { serviceName: b['@_serviceName'], items };
    } catch {
      return { items: [] };
    }
  }

  /** The current play queue (/Playlist). */
  async getQueue(): Promise<QueueItem[]> {
    try {
      const doc = (await this.get('/Playlist')) as Record<string, any>;
      const raw = doc?.playlist?.song;
      const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return arr.map((s: any) => ({
        title: s.title ?? s['@_title'],
        artist: s.art ?? s.artist ?? s['@_art'],
        album: s.alb ?? s.album ?? s['@_alb'],
      }));
    } catch {
      return [];
    }
  }

  /** Play a browse item by its playURL (a path like "/Play?url=..."). */
  playUrl(playURL: string): Promise<unknown> {
    const path = playURL.startsWith('/') ? playURL : `/${playURL}`;
    return this.get(path);
  }

  /** True if the BluOS HTTP API (port 11000) is responding. */
  async isAlive(): Promise<boolean> {
    try {
      await this.get('/SyncStatus');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a remote reboot of the BluOS module.
   *
   * Verified against this unit: BluOS exposes NO HTTP reboot endpoint — `/reboot`
   * and every common variant return 404, and triggering it does not reboot the
   * module (port 11000 never drops). So we do NOT pretend: we probe and report
   * the truth. If a future firmware adds a 200-returning reboot path, it works.
   */
  async reboot(): Promise<{ ok: boolean; detail: string }> {
    if (!(await this.isAlive())) {
      return {
        ok: false,
        detail:
          'BluOS HTTP API (port 11000) is not responding. Power-cycle the receiver from the rear ' +
          'switch (off ~30–60 s, then on).',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + '/reboot', { signal: controller.signal });
      if (res.ok) {
        return { ok: true, detail: 'Reboot requested. BluOS should drop off and return in ~1–2 min.' };
      }
      return {
        ok: false,
        detail:
          `This BluOS module has no remote-reboot API (HTTP ${res.status}). Reboot it from the ` +
          'BluOS app (Settings → Players → your player → Reboot) or power-cycle the receiver.',
      };
    } catch (e) {
      // A real reboot can drop the connection mid-response — but on this unit /reboot
      // is a 404, so an abort/network error here is NOT a reboot. Report honestly.
      return {
        ok: false,
        detail:
          `Could not confirm a reboot (${(e as Error).message}). Reboot from the BluOS app or ` +
          'power-cycle the receiver.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
