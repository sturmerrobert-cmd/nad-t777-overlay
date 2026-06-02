/**
 * State manager: polls NAD + BluOS, builds the AppState snapshot pushed to the
 * UI, and runs the over-cap alert / optional watchdog. It never raises volume.
 */

import { EventEmitter } from 'node:events';
import type { NadClient } from './nad/client.js';
import type { BluOSClient } from './bluos/client.js';
import type { VolumeService } from './volume/service.js';
import type { AppConfig } from './config.js';
import {
  DEFAULT_SOURCE_NAMES,
  type AppState,
  type NadState,
  type TunerState,
  type Zone2State,
} from './types.js';

export class StateManager extends EventEmitter {
  private state: AppState;
  private timer: NodeJS.Timeout | null = null;
  private startupReconciled = false;
  /** UI overrides for source names (take precedence over device names). */
  private nameOverrides: Record<number, string> = {};

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
      zone2: { overCapAlert: false },
      tuner: { active: false },
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
      zone2Safety: {
        maxVolumeDb: cfg.zone2MaxVolumeDb,
        maxStepDb: cfg.zone2MaxStepDb,
        warnVolumeDb: cfg.zone2WarnVolumeDb,
        defaultVolumeDb: cfg.DEFAULT_VOLUME_DB,
      },
      sourceNames: { ...DEFAULT_SOURCE_NAMES },
      diracAvailable: false, // Phase 0: port 5006 absent on this unit.
      updatedAt: 0,
    };
  }

  getState(): AppState {
    return this.state;
  }

  setSourceNameOverride(index: number, name: string): void {
    this.nameOverrides[index] = name;
    this.rebuildNad();
  }

  start(): void {
    this.nad.on('value', () => this.rebuildNad());
    this.nad.on('connect', () => {
      this.startupReconciled = false;
      this.nad.querySourceNames();
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
    this.rebuildNad();
  }

  /** Build source names: device-reported names, with UI overrides on top. */
  private buildSourceNames(): { names: Record<string, string>; tunerIndex?: number } {
    const names: Record<string, string> = {};
    let tunerIndex: number | undefined;
    for (let i = 1; i <= 12; i++) {
      const dev = this.nad.values.get(`Source${i}.Name`);
      const name = this.nameOverrides[i] ?? dev ?? DEFAULT_SOURCE_NAMES[i] ?? `Source ${i}`;
      names[i] = name;
      if (dev && /tuner/i.test(dev)) tunerIndex = i;
    }
    return { names, tunerIndex };
  }

  private rebuildNad(): void {
    const v = this.nad.values;
    const num = (k: string): number | undefined => {
      const raw = v.get(k);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const onOff = (k: string): boolean | undefined => {
      const raw = v.get(k);
      return raw === undefined ? undefined : /^on$/i.test(raw);
    };

    const nad: NadState = {
      reachable: this.nad.isConnected(),
      model: v.get('Main.Model'),
      version: v.get('Main.Version'),
      power: v.get('Main.Power') as NadState['power'],
      volumeDb: num('Main.Volume'),
      mute: onOff('Main.Mute'),
      source: num('Main.Source'),
      listeningMode: v.get('Main.ListeningMode'),
      dimmer: v.get('Main.Dimmer'),
      sleepMinutes: num('Main.Sleep'),
      signal: {
        codec: v.get('Main.Audio.CODEC'),
        channels: v.get('Main.Audio.Channels'),
        rateKhz: v.get('Main.Audio.Rate'),
        lock: v.get('Main.Audio.Lock'),
      },
    };

    const zone2Vol = num('Zone2.Volume');
    const zone2: Zone2State = {
      power: v.get('Zone2.Power') as Zone2State['power'],
      source: num('Zone2.Source'),
      volumeDb: zone2Vol,
      mute: onOff('Zone2.Mute'),
      overCapAlert: zone2Vol !== undefined && zone2Vol > this.cfg.zone2MaxVolumeDb,
    };

    const { names, tunerIndex } = this.buildSourceNames();
    const tuner: TunerState = {
      active: tunerIndex !== undefined && nad.source === tunerIndex,
      band: v.get('Tuner.Band'),
      fmFrequency: v.get('Tuner.FM.Frequency'),
      fmPreset: v.get('Tuner.FM.Preset'),
      mute: onOff('Tuner.FM.Mute'),
    };

    // Main over-cap alert + one-shot startup reconcile + watchdog.
    let overCapAlert = this.state.safety.overCapAlert;
    if (nad.volumeDb !== undefined) {
      overCapAlert = nad.volumeDb > this.cfg.maxVolumeDb;
      if (overCapAlert && !this.startupReconciled) {
        this.startupReconciled = true;
        this.volume.reconcileObserved('startup');
      }
      if (overCapAlert && this.cfg.VOLUME_WATCHDOG) {
        this.volume.reconcileObserved('watchdog');
      }
    }

    this.state = {
      ...this.state,
      nad,
      zone2,
      tuner,
      sourceNames: names,
      tunerSourceIndex: tunerIndex,
      safety: { ...this.state.safety, overCapAlert },
      updatedAt: Date.now(),
    };
    this.emit('state', this.state);
  }
}
