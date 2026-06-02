/**
 * NAD T 777 control client over raw TCP (port 23), NAD V2.x ASCII protocol.
 *
 * Commands are `Key.Sub?` (query), `Key.Sub=Value` (set), `Key.Sub+`/`-` (step),
 * each terminated by CR. The device answers with `Key.Sub=Value` lines, and also
 * emits unsolicited updates when state changes — we parse every line into a map.
 *
 * This client is intentionally "dumb" about volume safety: it exposes raw
 * setVolume/stepVolume primitives. ALL volume changes must go through the guarded
 * VolumeService, never directly here. (Enforced by convention + code review;
 * the HTTP layer never calls these volume methods directly.)
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { CAPABILITY_PROBE_KEYS } from './capabilities.js';
import { resolveKey } from './aliases.js';

export interface NadClientOptions {
  host: string;
  port: number;
  reconnectMs?: number;
}

type Listener = (key: string, value: string) => void;

export class NadClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private connected = false;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly reconnectMs: number;

  /** Last value seen for each key, e.g. "Main.Volume" → "-56". */
  readonly values = new Map<string, string>();

  constructor(private readonly opts: NadClientOptions) {
    super();
    this.reconnectMs = opts.reconnectMs ?? 3000;
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.closing = false;
    this.connect();
  }

  stop(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  private connect(): void {
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    socket.setEncoding('utf8');
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      this.emit('connect');
    });

    socket.on('data', (chunk: string) => this.onData(chunk));

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.emit('disconnect');
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.values.set(key, value);
      this.emit('value', key, value);
    }
  }

  /** Low-level write of a single command (CR-terminated). */
  private write(cmd: string): void {
    if (!this.socket || !this.connected) {
      throw new Error('NAD not connected');
    }
    this.socket.write(cmd + '\r');
  }

  /** Send a `?` query. The reply arrives asynchronously via the 'value' event. */
  query(key: string): void {
    this.write(`${key}?`);
  }

  /** Refresh the core state keys we care about. */
  pollState(): void {
    if (!this.connected) return;
    for (const k of [
      'Main.Model',
      'Main.Version',
      'Main.Power',
      'Main.Volume',
      'Main.Mute',
      'Main.Source',
      'Main.ListeningMode',
      'Main.Dimmer',
      'Main.Sleep',
      // Incoming audio signal / format (shown on the receiver's display).
      'Main.Audio.CODEC',
      'Main.Audio.Channels',
      'Main.Audio.Rate',
      'Main.Audio.Lock',
      'Main.Audio.Delay',
      'Main.Video.Resolution',
      // Tone
      'Main.Bass',
      'Main.Treble',
      'Main.ToneDefeat',
      // Bass management / speaker setup
      'Main.Speaker.Sub',
      'Main.EnhancedBass',
      'Main.Level.Center',
      'Main.Level.Sub',
      'Main.CenterDialog',
      'Main.Speaker.Front.Config',
      'Main.Speaker.Front.Frequency',
      'Main.Speaker.Center.Config',
      'Main.Speaker.Center.Frequency',
      'Main.Speaker.Surround.Config',
      'Main.Speaker.Surround.Frequency',
      // Surround params
      'Main.Dolby.CenterSpread',
      'Main.Dolby.CenterWidth',
      'Main.Dolby.DRC',
      'Main.Dolby.Panorama',
      'Main.Dolby.Dimension',
      'Main.DTS.CenterGain',
      'Main.DTS.DRC',
      'Main.DTS.DialogControl',
      // System
      'Main.AutoStandby',
      'Main.OSD.TempDisplay',
      'Main.CEC.ARC',
      'Main.CEC.Audio',
      'Main.CEC.Power',
      'Main.CEC.Switch',
      'Main.Trigger1.Out',
      'Main.Trigger2.Out',
      'Zone2.Power',
      'Zone2.Source',
      'Zone2.Volume',
      'Zone2.Mute',
      'Zone2.VolumeControl',
      'Zone2.VolumeFixed',
      // Tuner keys only answer when the tuner is the active source.
      'Tuner.Band',
      'Tuner.FM.Frequency',
      'Tuner.FM.Preset',
      'Tuner.Preset', // first-gen alias of Tuner.FM.Preset
      'Tuner.FM.Mute',
    ]) {
      this.write(`${k}?`);
    }
  }

  /** Query the configured display names for all 12 sources (once at connect). */
  querySourceNames(): void {
    if (!this.connected) return;
    for (let i = 1; i <= 12; i++) this.write(`Source${i}.Name?`);
  }

  /**
   * Fire a `?` for every capability-probe key (once at connect). Unsupported
   * keys stay silent; supported ones populate `values`. The state manager reads
   * the result after a short discovery window to decide which UI to show.
   */
  probeCapabilities(): void {
    if (!this.connected) return;
    for (const k of CAPABILITY_PROBE_KEYS) this.write(`${k}?`);
  }

  /** Wait until a specific key reports a value (or time out). Used at startup. */
  async readValue(key: string, timeoutMs = 3000): Promise<string | undefined> {
    if (this.values.has(key)) return this.values.get(key);
    return new Promise((resolve) => {
      const onValue: Listener = (k, v) => {
        if (k === key) {
          this.off('value', onValue);
          clearTimeout(t);
          resolve(v);
        }
      };
      const t = setTimeout(() => {
        this.off('value', onValue);
        resolve(undefined);
      }, timeoutMs);
      this.on('value', onValue);
      try {
        this.query(key);
      } catch {
        clearTimeout(t);
        this.off('value', onValue);
        resolve(undefined);
      }
    });
  }

  // --- Raw control primitives. Volume ones are for the guarded service ONLY. ---

  setPower(on: boolean): void {
    this.write(`Main.Power=${on ? 'On' : 'Off'}`);
  }

  setMute(on: boolean): void {
    this.write(`Main.Mute=${on ? 'On' : 'Off'}`);
  }

  setSource(index: number): void {
    if (!Number.isInteger(index) || index < 1 || index > 12) {
      throw new Error(`source out of range 1-12: ${index}`);
    }
    this.write(`Main.Source=${index}`);
  }

  setListeningMode(mode: string): void {
    this.write(`Main.ListeningMode=${mode}`);
  }

  /** Front-panel display dimming. Observed enum value: "Off". */
  setDimmer(on: boolean): void {
    this.write(`Main.Dimmer=${on ? 'On' : 'Off'}`);
  }

  /** Sleep timer in minutes; 0 turns it off. */
  setSleep(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0) {
      throw new Error(`invalid sleep minutes: ${minutes}`);
    }
    this.write(`Main.Sleep=${minutes}`);
  }

  // --- Zone 2 ---
  setZone2Power(on: boolean): void {
    this.write(`Zone2.Power=${on ? 'On' : 'Off'}`);
  }
  setZone2Source(index: number): void {
    if (!Number.isInteger(index) || index < 1 || index > 12) {
      throw new Error(`zone2 source out of range 1-12: ${index}`);
    }
    this.write(`Zone2.Source=${index}`);
  }
  setZone2Mute(on: boolean): void {
    this.write(`Zone2.Mute=${on ? 'On' : 'Off'}`);
  }
  /** RAW Zone 2 volume set — call ONLY from the guarded VolumeService. */
  rawSetZone2VolumeDb(db: number): void {
    this.write(`Zone2.Volume=${db}`);
  }

  // --- Tuner (responds only when the tuner is the active source) ---
  setTunerBand(band: 'FM' | 'AM'): void {
    this.write(`Tuner.Band=${band}`);
  }
  setTunerFmPreset(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid FM preset: ${n}`);
    // First-gen receivers name this `Tuner.Preset`; resolve to whichever the
    // connected device actually speaks (falls back to the modern name on V3).
    this.write(`${resolveKey(this.values, 'Tuner.FM.Preset')}=${n}`);
  }
  setTunerMute(on: boolean): void {
    this.write(`Tuner.FM.Mute=${on ? 'On' : 'Off'}`);
  }
  /** Step FM frequency up/down (uses the NAD +/- step on the frequency key). */
  tuneFm(dir: 'up' | 'down'): void {
    this.write(`Tuner.FM.Frequency${dir === 'up' ? '+' : '-'}`);
  }

  /**
   * Generic setter for NON-volume settings (tone, speakers, CEC, …).
   * Hard-refuses any "Volume" key so it can never bypass the volume guard.
   */
  setSetting(key: string, value: string): void {
    if (/volume/i.test(key)) {
      throw new Error(`setSetting refused for volume key "${key}" — use the guarded VolumeService`);
    }
    this.write(`${key}=${value}`);
  }

  /** RAW absolute volume set — call ONLY from the guarded VolumeService. */
  rawSetVolumeDb(db: number): void {
    this.write(`Main.Volume=${db}`);
  }
}
