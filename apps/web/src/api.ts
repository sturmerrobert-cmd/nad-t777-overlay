import { useEffect, useRef, useState } from 'react';
import type { AppState } from './types';

export interface ApiResult {
  ok: boolean;
  reason?: string;
  note?: string;
  targetDb?: number;
  clamped?: boolean;
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
  // BluOS
  bluosPreset: (id: number) => post('/api/bluos/preset', { id }),
  bluosTransport: (action: 'play' | 'pause' | 'skip' | 'back') =>
    post('/api/bluos/transport', { action }),
};

export async function fetchPresets(): Promise<Array<{ id: number; name: string }>> {
  try {
    const res = await fetch('/api/bluos/presets');
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
