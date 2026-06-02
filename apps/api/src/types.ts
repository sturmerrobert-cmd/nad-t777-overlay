/** Shared state shapes pushed to the UI over WebSocket. */

export interface NadState {
  reachable: boolean;
  model?: string;
  version?: string;
  power?: 'On' | 'Off';
  /** Master volume in dB (louder = higher). */
  volumeDb?: number;
  mute?: boolean;
  /** Source index 1-12. */
  source?: number;
  listeningMode?: string;
  /** Front-panel display dimming (verified value: "Off"). */
  dimmer?: string;
  /** Sleep timer in minutes; 0 = off. */
  sleepMinutes?: number;
  /** Incoming audio signal/format, as the receiver decodes it. */
  signal?: AudioSignal;
}

export interface AudioSignal {
  codec?: string; // PCM | Dolby Digital | DTS | ...  (Main.Audio.CODEC)
  channels?: string; // e.g. "2/0.0", "3/2.1"          (Main.Audio.Channels)
  rateKhz?: string; // sample rate in kHz               (Main.Audio.Rate)
  lock?: string; // signal lock Yes/No                  (Main.Audio.Lock)
}

export interface Zone2State {
  power?: 'On' | 'Off';
  source?: number;
  /** Zone 2 volume in dB — guarded by the SAME cap/step as Main. */
  volumeDb?: number;
  mute?: boolean;
  /** Raised when Zone 2 observed volume is above the cap. */
  overCapAlert: boolean;
}

export interface TunerState {
  /** True when the active Main source is the tuner (controls respond only then). */
  active: boolean;
  band?: string; // FM | AM
  fmFrequency?: string;
  fmPreset?: string;
  mute?: boolean;
}

export interface NowPlaying {
  reachable: boolean;
  state?: string; // play | pause | stop | stream ...
  title?: string;
  artist?: string;
  album?: string;
  imageUrl?: string;
  service?: string;
  /** BluOS 0-100 volume + its dB readout (for cross-check, not control). */
  bluosVolume?: number;
  bluosDb?: number;
  quality?: string;
}

export interface VolumeSafety {
  maxVolumeDb: number;
  maxStepDb: number;
  warnVolumeDb?: number;
  defaultVolumeDb?: number;
  clampOnObserved: boolean;
  watchdog: boolean;
  /** Raised when observed Main volume is above the cap (rule 5). */
  overCapAlert: boolean;
}

/** Per-channel guard settings (Zone 2 has its own cap). */
export interface ChannelSafety {
  maxVolumeDb: number;
  maxStepDb: number;
  warnVolumeDb?: number;
  defaultVolumeDb?: number;
}

export interface AppState {
  nad: NadState;
  zone2: Zone2State;
  tuner: TunerState;
  nowPlaying: NowPlaying;
  safety: VolumeSafety;
  /** Zone 2's own guard settings (separate cap). */
  zone2Safety: ChannelSafety;
  /** Source index → display name (from the device, UI-overridable). */
  sourceNames: Record<string, string>;
  /** Which source index is the tuner (from device names), if any. */
  tunerSourceIndex?: number;
  /** Dirac REST API was absent in Phase 0 discovery; always false here. */
  diracAvailable: boolean;
  /** Last server-side warning/clamp message, surfaced to the UI. */
  lastNotice?: string;
  updatedAt: number;
}

/** Fallback source labels when the device has not reported a name yet. */
export const DEFAULT_SOURCE_NAMES: Record<number, string> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [i + 1, `Source ${i + 1}`]),
);
