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
    ]) {
      this.write(`${k}?`);
    }
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

  /** RAW absolute volume set — call ONLY from the guarded VolumeService. */
  rawSetVolumeDb(db: number): void {
    this.write(`Main.Volume=${db}`);
  }
}
