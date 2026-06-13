import { useEffect, useRef, useState } from 'react';
import type { AppState, BrowseResult, QueueItem, TrackEntry, UsageLog } from './types';

export interface ApiResult {
  ok: boolean;
  reason?: string;
  /** Error message from the settings endpoints (refused/clamped/etc.). */
  error?: string;
  note?: string;
  targetDb?: number;
  clamped?: boolean;
  /** Confirmed value echoed back by the settings endpoints. */
  value?: string;
}

async function post(path: string, body: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiResult;
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export const api = {
  // Main
  power: (on: boolean) => post('/api/power', { on }),
  mute: (on: boolean) => post('/api/mute', { on }),
  source: (index: number) => post('/api/source', { index }),
  listeningMode: (mode: string) => post('/api/listening-mode', { mode }),
  dimmer: (on: boolean) => post('/api/dimmer', { on }),
  sleep: (minutes: number) => post('/api/sleep', { minutes }),
  volumeStep: (deltaDb: number) => post('/api/volume/step', { deltaDb }),
  volumeSet: (targetDb: number) => post('/api/volume/set', { targetDb }),
  sourceNames: (names: Record<string, string>) => post('/api/source-names', { names }),
  // Zone 2 (volume guarded by the same cap/step)
  zone2Power: (on: boolean) => post('/api/zone2/power', { on }),
  zone2Source: (index: number) => post('/api/zone2/source', { index }),
  zone2Mute: (on: boolean) => post('/api/zone2/mute', { on }),
  zone2VolumeStep: (deltaDb: number) => post('/api/zone2/volume/step', { deltaDb }),
  zone2VolumeSet: (targetDb: number) => post('/api/zone2/volume/set', { targetDb }),
  // Tuner
  tunerBand: (band: 'FM' | 'AM') => post('/api/tuner/band', { band }),
  tunerPreset: (n: number) => post('/api/tuner/preset', { n }),
  tunerMute: (on: boolean) => post('/api/tuner/mute', { on }),
  tunerTune: (dir: 'up' | 'down') => post('/api/tuner/tune', { dir }),
  // Auto-switch source to the streaming module on playback + manual activate (never volume)
  autoswitch: (on: boolean) => post('/api/autoswitch', { on }),
  streamActivate: () => post('/api/stream/activate', {}),
  streamReboot: () => post('/api/stream/reboot', {}),
  // the streaming module browse / play (same control as the the streaming module app)
  streamPlayUrl: (url: string) => post('/api/stream/play-url', { url }),
  tracksClear: () => post('/api/tracks/clear', {}),
  // Generic allowlisted settings (never volume — server refuses volume keys)
  setting: (key: string, value: string | boolean | number) => post('/api/setting', { key, value }),
  settingStep: (key: string, delta: number) => post('/api/setting/step', { key, delta }),
  // the streaming module
  streamPreset: (id: number) => post('/api/stream/preset', { id }),
  streamTransport: (action: 'play' | 'pause' | 'skip' | 'back') =>
    post('/api/stream/transport', { action }),
};

export async function fetchUsage(limit = 200): Promise<UsageLog> {
  try {
    const res = await fetch(`/api/usage?limit=${limit}`);
    return (await res.json()) as UsageLog;
  } catch {
    return { current: null, segments: [] };
  }
}

export function usageClear(): Promise<ApiResult> {
  return post('/api/usage/clear', {});
}

export async function fetchTracks(limit = 1000): Promise<TrackEntry[]> {
  try {
    const res = await fetch(`/api/tracks?limit=${limit}`);
    return ((await res.json()) as { tracks: TrackEntry[] }).tracks ?? [];
  } catch {
    return [];
  }
}

export async function fetchBrowse(key?: string): Promise<BrowseResult> {
  try {
    const res = await fetch(`/api/stream/browse${key ? `?key=${encodeURIComponent(key)}` : ''}`);
    return (await res.json()) as BrowseResult;
  } catch {
    return { items: [] };
  }
}

export async function fetchQueue(): Promise<QueueItem[]> {
  try {
    const res = await fetch('/api/stream/queue');
    return ((await res.json()) as { queue: QueueItem[] }).queue ?? [];
  } catch {
    return [];
  }
}

export async function fetchPresets(): Promise<Array<{ id: number; name: string }>> {
  try {
    const res = await fetch('/api/stream/presets');
    const j = (await res.json()) as { presets: Array<{ id: number; name: string }> };
    return j.presets ?? [];
  } catch {
    return [];
  }
}

/** Subscribe to live AppState over WebSocket, with auto-reconnect. */
export function useLiveState(): { state: AppState | null; connected: boolean } {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state') setState(msg.payload as AppState);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return { state, connected };
}
