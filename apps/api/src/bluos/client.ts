/**
 * BluOS client (HTTP GET, port 11000, UTF-8 XML).
 *
 * Used read-mostly: now-playing from /Status, sync/volume from /SyncStatus,
 * plus presets and transport. The BluOS /Volume path is also clamped by the
 * guarded service; primary volume enforcement is the NAD master volume.
 */

import { XMLParser } from 'fast-xml-parser';
import type { NowPlaying } from '../types.js';

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
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  private async get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.base + path, { signal: controller.signal });
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
}
