/**
 * State manager: polls NAD + BluOS, builds the AppState snapshot pushed to the
 * UI, and runs the over-cap alert / optional watchdog. It never raises volume.
 */

import { EventEmitter } from 'node:events';
import type { NadClient } from './nad/client.js';
import type { BluOSClient } from './bluos/client.js';
import type { VolumeService } from './volume/service.js';
import type { AppConfig } from './config.js';
import type { AppState, NadState, NowPlaying } from './types.js';

export class StateManager extends EventEmitter {
  private state: AppState;
  private timer: NodeJS.Timeout | null = null;
  private startupReconciled = false;

  constructor(
    private readonly nad: NadClient,
    private readonly bluos: BluOSClient,
    private readonly volume: VolumeService,
    private readonly cfg: AppConfig,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    super();
    this.state = {
      nad: { reachable: false },
      nowPlaying: { reachable: false },
      safety: {
        maxVolumeDb: cfg.maxVolumeDb,
        maxStepDb: cfg.maxStepDb,
        warnVolumeDb: cfg.WARN_VOLUME_DB,
        defaultVolumeDb: cfg.DEFAULT_VOLUME_DB,
        clampOnObserved: cfg.CLAMP_ON_OBSERVED,
        watchdog: cfg.VOLUME_WATCHDOG,
        overCapAlert: false,
      },
      diracAvailable: false, // Phase 0: port 5006 absent on this unit.
      updatedAt: 0,
    };
  }

  getState(): AppState {
    return this.state;
  }

  start(): void {
    // React to live NAD updates immediately, plus poll on an interval.
    this.nad.on('value', () => this.rebuildNad());
    this.nad.on('connect', () => {
      this.startupReconciled = false;
      this.nad.pollState();
    });
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  setNotice(msg: string): void {
    this.state = { ...this.state, lastNotice: msg, updatedAt: Date.now() };
    this.emit('state', this.state);
  }

  private async poll(): Promise<void> {
    if (this.nad.isConnected()) this.nad.pollState();
    const nowPlaying = await this.bluos.getNowPlaying();
    this.state = { ...this.state, nowPlaying, updatedAt: Date.now() };
    this.rebuildNad(); // also re-evaluates safety + emits
  }

  private rebuildNad(): void {
    const v = this.nad.values;
    const num = (k: string): number | undefined => {
      const raw = v.get(k);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };

    const nad: NadState = {
      reachable: this.nad.isConnected(),
      model: v.get('Main.Model'),
      version: v.get('Main.Version'),
      power: v.get('Main.Power') as NadState['power'],
      volumeDb: num('Main.Volume'),
      mute: v.get('Main.Mute') ? /^on$/i.test(v.get('Main.Mute')!) : undefined,
      source: num('Main.Source'),
      listeningMode: v.get('Main.ListeningMode'),
    };

    // Over-cap alert + one-shot startup reconcile + watchdog.
    let overCapAlert = this.state.safety.overCapAlert;
    if (nad.volumeDb !== undefined) {
      overCapAlert = nad.volumeDb > this.cfg.maxVolumeDb;

      if (overCapAlert && !this.startupReconciled) {
        this.startupReconciled = true;
        this.volume.reconcileObserved('startup'); // alert-only unless CLAMP_ON_OBSERVED
      }
      if (overCapAlert && this.cfg.VOLUME_WATCHDOG) {
        this.volume.reconcileObserved('watchdog');
      }
    }

    this.state = {
      ...this.state,
      nad,
      safety: { ...this.state.safety, overCapAlert },
      updatedAt: Date.now(),
    };
    this.emit('state', this.state);
  }
}
