/**
 * State manager: polls NAD + BO, builds the AppState snapshot pushed to the
 * UI, and runs the over-cap alert / optional watchdog. It never raises volume.
 */

import { EventEmitter } from 'node:events';
import type { NadClient } from './nad/client.js';
import type { StreamClient } from './stream/client.js';
import type { VolumeService } from './volume/service.js';
import type { UsageLogger } from './usage/logger.js';
import type { TrackLogger } from './tracks/logger.js';
import type { AppConfig } from './config.js';
import { computeCapabilities, DIRAC_ENABLED } from './nad/capabilities.js';
import { getAliased } from './nad/aliases.js';
import { probeTcpOpen } from './discover.js';
import {
  DEFAULT_SOURCE_NAMES,
  type AppState,
  type NadState,
  type TunerState,
  type Zone2State,
} from './types.js';

/** Dirac Live control port; only Dirac-equipped models open it. */
const DIRAC_PORT = 5006;
/** How long after connect to keep probing before "no answer" ⇒ unsupported. */
const DISCOVERY_WINDOW_MS = 4000;

export class StateManager extends EventEmitter {
  private state: AppState;
  private timer: NodeJS.Timeout | null = null;
  private startupReconciled = false;
  /** UI overrides for source names (take precedence over device names). */
  private nameOverrides: Record<number, string> = {};
  private autoSwitchOnPlay: boolean;
  /** Whether we've already acted for the current BO playing session. */
  private autoHandled = false;
  /** Guards against BO request pile-up when its HTTP server is slow/hung. */
  private streamInFlight = false;
  /** Capability discovery: true once the probe window has elapsed. */
  private capabilitiesReady = false;
  /** Dirac control port (:5006) reachable — set by the connect-time probe. */
  private diracOpen = false;
  /** Pending discovery-window timer, cleared/reset on each (re)connect. */
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly nad: NadClient,
    private readonly stream: StreamClient,
    private readonly volume: VolumeService,
    private readonly usage: UsageLogger,
    private readonly tracks: TrackLogger,
    private readonly cfg: AppConfig,
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    super();
    this.autoSwitchOnPlay = cfg.AUTOSWITCH_ON_PLAY;
    this.state = {
      autoSwitchOnPlay: cfg.AUTOSWITCH_ON_PLAY,
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
      diracAvailable: false, // resolved by the connect-time :5006 probe.
      capabilities: {},
      capabilitiesReady: false,
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
      this.beginDiscovery();
    });
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
  }

  /**
   * Start runtime capability discovery on (re)connect: fire the probe `?` burst,
   * test the Dirac port out-of-band, and arm the window after which a silent key
   * counts as unsupported. Re-running on reconnect re-probes a (possibly swapped)
   * device cleanly.
   */
  private beginDiscovery(): void {
    this.capabilitiesReady = false;
    this.diracOpen = false;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);

    this.nad.probeCapabilities();

    // Out-of-band: is the Dirac control port open? Gated behind DIRAC_ENABLED —
    // disabled by default (legal risk: Dirac mark + unofficial :5006 API), so we
    // do NOT touch :5006 at all unless explicitly turned on.
    if (DIRAC_ENABLED) {
      void probeTcpOpen(this.cfg.DEVICE_IP, DIRAC_PORT)
        .then((open) => {
          this.diracOpen = open;
          if (open) this.log('info', `Dirac control port (:${DIRAC_PORT}) detected`);
        })
        .catch(() => {})
        .finally(() => this.rebuildNad());
    }

    this.discoveryTimer = setTimeout(() => {
      this.capabilitiesReady = true;
      const caps = this.state.capabilities;
      const supported = Object.entries(caps)
        .filter(([, s]) => s === 'supported')
        .map(([id]) => id);
      this.log('info', `capability discovery done — ${supported.length} features: ${supported.join(', ')}`);
      this.rebuildNad();
    }, DISCOVERY_WINDOW_MS);
  }

  setNotice(msg: string): void {
    this.state = { ...this.state, lastNotice: msg, updatedAt: Date.now() };
    this.emit('state', this.state);
  }

  private poll(): void {
    // NAD control (TCP) is fast and must never be blocked by a slow/dead BO.
    if (this.nad.isConnected()) this.nad.pollState();
    this.refreshStream(); // independent, non-blocking — see below
    this.rebuildNad(); // push NAD state immediately every tick

    // Sample usage once per poll cycle (source + volume over time).
    const { nad, sourceNames } = this.state;
    const name = nad.source ? sourceNames[String(nad.source)] ?? `Source ${nad.source}` : '';
    this.usage.observe(nad.power, nad.source, name, nad.volumeDb, Date.now());

    // Capture distinct played tracks (metadata only) for the "shopping list".
    this.tracks.observe(this.state.nowPlaying, Date.now());

    // Auto-switch the receiver to BO when a stream starts (never touches volume).
    this.evaluateAutoSwitch();
  }

  /**
   * Fetch BO now-playing independently of the NAD poll. A hung BO (its
   * HTTP server can crash while the receiver itself is fine) must not stall NAD
   * control/state. The in-flight guard prevents request pile-up when it's slow.
   */
  private refreshStream(): void {
    if (this.streamInFlight) return;
    this.streamInFlight = true;
    void this.stream
      .getNowPlaying()
      .then((nowPlaying) => {
        this.state = { ...this.state, nowPlaying, updatedAt: Date.now() };
        this.emit('state', this.state);
      })
      .finally(() => {
        this.streamInFlight = false;
      });
  }

  /** Build source names: device-reported names, with UI overrides on top. */
  private buildSourceNames(): {
    names: Record<string, string>;
    tunerIndex?: number;
    streamIndex?: number;
  } {
    const names: Record<string, string> = {};
    let tunerIndex: number | undefined;
    let streamIndex: number | undefined;
    for (let i = 1; i <= 12; i++) {
      // `dev` is the input label REPORTED BY THE DEVICE (SourceN.Name), e.g. the
      // receiver may name an input "BluOS" or "Tuner". These are the device's own
      // labels, NOT our branding — we only render them and match on them to find
      // which source index is the streaming module / tuner. We never inject brand
      // names into static strings ourselves.
      const dev = this.nad.values.get(`Source${i}.Name`);
      const name = this.nameOverrides[i] ?? dev ?? DEFAULT_SOURCE_NAMES[i] ?? `Source ${i}`;
      names[i] = name;
      if (dev && /tuner/i.test(dev)) tunerIndex = i;
      if (dev && /blu\s*os/i.test(dev)) streamIndex = i;
    }
    return { names, tunerIndex, streamIndex };
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
        delay: v.get('Main.Audio.Delay'),
        videoResolution: v.get('Main.Video.Resolution'),
      },
      tone: {
        bass: num('Main.Bass'),
        treble: num('Main.Treble'),
        toneDefeat: onOff('Main.ToneDefeat'),
      },
      setup: {
        subOn: onOff('Main.Speaker.Sub'),
        enhancedBass: onOff('Main.EnhancedBass'),
        levelFrontLeft: num('Main.Level.Left'),
        levelFrontRight: num('Main.Level.Right'),
        levelCenter: num('Main.Level.Center'),
        levelSurroundLeft: num('Main.Level.SurroundLeft'),
        levelSurroundRight: num('Main.Level.SurroundRight'),
        levelBackLeft: num('Main.Level.BackLeft'),
        levelBackRight: num('Main.Level.BackRight'),
        levelSub: num('Main.Level.Sub'),
        centerDialog: num('Main.CenterDialog'),
        frontConfig: v.get('Main.Speaker.Front.Config'),
        frontFreq: v.get('Main.Speaker.Front.Frequency'),
        centerConfig: v.get('Main.Speaker.Center.Config'),
        centerFreq: v.get('Main.Speaker.Center.Frequency'),
        surroundConfig: v.get('Main.Speaker.Surround.Config'),
        surroundFreq: v.get('Main.Speaker.Surround.Frequency'),
      },
      surround: {
        dolbyCenterSpread: onOff('Main.Dolby.CenterSpread'),
        dolbyCenterWidth: v.get('Main.Dolby.CenterWidth'),
        dolbyDrc: v.get('Main.Dolby.DRC'),
        dolbyPanorama: onOff('Main.Dolby.Panorama'),
        dolbyDimension: v.get('Main.Dolby.Dimension'),
        dtsCenterGain: v.get('Main.DTS.CenterGain'),
        dtsDrc: v.get('Main.DTS.DRC'),
        dtsDialogControl: v.get('Main.DTS.DialogControl'),
      },
      system: {
        autoStandby: onOff('Main.AutoStandby'),
        osdTempDisplay: onOff('Main.OSD.TempDisplay'),
        cecArc: getAliased(v, 'Main.CEC.ARC'),
        cecAudio: onOff('Main.CEC.Audio'),
        cecPower: onOff('Main.CEC.Power'),
        cecSwitch: onOff('Main.CEC.Switch'),
        trigger1Out: v.get('Main.Trigger1.Out'),
        trigger2Out: v.get('Main.Trigger2.Out'),
      },
      vfd: {
        line1: v.get('Main.VFD.Line1'),
        line2: v.get('Main.VFD.Line2'),
        display: v.get('Main.VFD.Display'),
      },
    };

    const zone2Vol = num('Zone2.Volume');
    const zone2: Zone2State = {
      power: v.get('Zone2.Power') as Zone2State['power'],
      source: num('Zone2.Source'),
      volumeDb: zone2Vol,
      mute: onOff('Zone2.Mute'),
      overCapAlert: zone2Vol !== undefined && zone2Vol > this.cfg.zone2MaxVolumeDb,
      volumeControl: v.get('Zone2.VolumeControl'),
      volumeFixed: num('Zone2.VolumeFixed'),
    };

    const { names, tunerIndex, streamIndex } = this.buildSourceNames();
    const tuner: TunerState = {
      active: tunerIndex !== undefined && nad.source === tunerIndex,
      band: v.get('Tuner.Band'),
      fmFrequency: v.get('Tuner.FM.Frequency'),
      fmPreset: getAliased(v, 'Tuner.FM.Preset'),
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

    const capabilities = computeCapabilities(v, {
      ready: this.capabilitiesReady,
      stream: this.state.nowPlaying.reachable,
      dirac: this.diracOpen,
      tunerSourceIndex: tunerIndex,
    });

    this.state = {
      ...this.state,
      nad,
      zone2,
      tuner,
      sourceNames: names,
      tunerSourceIndex: tunerIndex,
      streamSourceIndex: streamIndex,
      autoSwitchOnPlay: this.autoSwitchOnPlay,
      safety: { ...this.state.safety, overCapAlert },
      diracAvailable: capabilities.dirac === 'supported',
      capabilities,
      capabilitiesReady: this.capabilitiesReady,
      updatedAt: Date.now(),
    };
    this.emit('state', this.state);
  }

  setAutoSwitch(on: boolean): void {
    this.autoSwitchOnPlay = on;
    // Re-arm so enabling it while a stream is already playing takes effect now.
    if (on) this.autoHandled = false;
    this.state = { ...this.state, autoSwitchOnPlay: on, updatedAt: Date.now() };
    this.emit('state', this.state);
  }

  /** Is BO actively playing (vs paused/stopped)? */
  private static isPlaying(npState?: string): boolean {
    return npState !== undefined && /^(play|stream)/i.test(npState);
  }

  /**
   * Route the NAD to BO so a stream is actually audible: power on if off and
   * select the BO source. NEVER changes volume (G2). Used by the auto-switch
   * edge trigger and the manual "play on NAD" button.
   *
   * @returns a short status for the manual caller.
   */
  activateStream(reason: 'auto' | 'manual'): { ok: boolean; message: string } {
    const idx = this.state.streamSourceIndex;
    if (idx === undefined) {
      const m = 'no streaming source detected on the receiver (no input named "BluOS")';
      this.log('warn', `activateStream(${reason}): ${m}`);
      return { ok: false, message: m };
    }
    const nad = this.state.nad;
    if (!nad.reachable) return { ok: false, message: 'NAD not reachable' };

    const actions: string[] = [];
    try {
      if (nad.power !== 'On') {
        this.nad.setPower(true);
        actions.push('power on');
      }
      if (nad.source !== idx) {
        this.nad.setSource(idx);
        actions.push(`source → BO (${idx})`);
        // Selecting the BO source re-attaches the stream; nudge Play so it
        // resumes deterministically (manual "play on NAD"). Fire-and-forget.
        void this.stream.play().catch(() => {});
      }
    } catch (e) {
      return { ok: false, message: `failed: ${(e as Error).message}` };
    }
    // Volume is deliberately left untouched (G2).
    const msg =
      actions.length > 0
        ? `${reason === 'auto' ? 'Auto-switched' : 'Switched'} to BO: ${actions.join(', ')} (volume unchanged)`
        : 'already on BO';
    if (actions.length > 0) {
      this.log('info', `activateStream(${reason}): ${actions.join(', ')}`);
      this.setNotice(msg);
    }
    return { ok: true, message: msg };
  }

  /**
   * Auto-switch to BO once per playing session (called each poll).
   *
   * Acts when a stream is playing and we haven't handled this session yet — so it
   * fires even if playback was already running when auto-switch was enabled. After
   * acting (or if already on BO), it marks the session handled, so a later
   * MANUAL source change while the stream keeps playing is not yanked back.
   * Resets when playback stops/pauses.
   */
  private evaluateAutoSwitch(): void {
    const playing = StateManager.isPlaying(this.state.nowPlaying.state);
    if (!playing) {
      this.autoHandled = false;
      return;
    }
    if (!this.autoSwitchOnPlay || this.autoHandled) return;
    if (this.state.streamSourceIndex === undefined) return;

    const r = this.activateStream('auto');
    if (r.ok) this.autoHandled = true; // handled for this session
  }
}
