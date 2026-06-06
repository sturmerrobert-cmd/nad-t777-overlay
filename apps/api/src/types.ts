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
  tone?: ToneState;
  setup?: SetupState;
  surround?: SurroundState;
  system?: SystemState;
}

export interface AudioSignal {
  codec?: string; // PCM | Dolby Digital | DTS | ...  (Main.Audio.CODEC)
  channels?: string; // e.g. "2/0.0", "3/2.1"          (Main.Audio.Channels)
  rateKhz?: string; // sample rate in kHz               (Main.Audio.Rate)
  lock?: string; // signal lock Yes/No                  (Main.Audio.Lock)
  delay?: string; // A/V delay (Main.Audio.Delay)
  videoResolution?: string; // Main.Video.Resolution
}

export interface ToneState {
  bass?: number;
  treble?: number;
  toneDefeat?: boolean;
}

export interface SetupState {
  subOn?: boolean;
  enhancedBass?: boolean;
  /** Per-speaker calibration levels in dB (-12..+12). Absent channels stay undefined. */
  levelFrontLeft?: number;
  levelFrontRight?: number;
  levelCenter?: number;
  levelSurroundLeft?: number;
  levelSurroundRight?: number;
  levelBackLeft?: number;
  levelBackRight?: number;
  levelSub?: number;
  centerDialog?: number;
  frontConfig?: string;
  frontFreq?: string;
  centerConfig?: string;
  centerFreq?: string;
  surroundConfig?: string;
  surroundFreq?: string;
}

export interface SurroundState {
  dolbyCenterSpread?: boolean;
  dolbyCenterWidth?: string;
  dolbyDrc?: string;
  dolbyPanorama?: boolean;
  dolbyDimension?: string;
  dtsCenterGain?: string;
  dtsDrc?: string;
  dtsDialogControl?: string;
}

export interface SystemState {
  autoStandby?: boolean;
  osdTempDisplay?: boolean;
  cecArc?: string;
  cecAudio?: boolean;
  cecPower?: boolean;
  cecSwitch?: boolean;
  trigger1Out?: string;
  trigger2Out?: string;
}

export interface Zone2State {
  power?: 'On' | 'Off';
  source?: number;
  /** Zone 2 volume in dB — guarded by the SAME cap/step as Main. */
  volumeDb?: number;
  mute?: boolean;
  /** Raised when Zone 2 observed volume is above the cap. */
  overCapAlert: boolean;
  /** Variable | Fixed output mode. */
  volumeControl?: string;
  volumeFixed?: number;
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

/** Per-feature runtime support, keyed by capability id (see nad/capabilities.ts). */
export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type DeviceCapabilities = Record<string, CapabilityStatus>;

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
  /** Which source index is BluOS (from device names), if any. */
  bluosSourceIndex?: number;
  /** When true, auto-switch source to BluOS (+power on) on playback start. */
  autoSwitchOnPlay: boolean;
  /** Dirac control port (:5006) reachable — probed at connect. */
  diracAvailable: boolean;
  /** Runtime-discovered per-feature support; UI shows only what's supported. */
  capabilities: DeviceCapabilities;
  /** True once the capability discovery window has elapsed (results are final). */
  capabilitiesReady: boolean;
  /** Last server-side warning/clamp message, surfaced to the UI. */
  lastNotice?: string;
  updatedAt: number;
}

/** One usage segment: a continuous stretch on a single source while powered on. */
export interface UsageSegment {
  source: number;
  sourceName: string;
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms (for the open segment: last poll seen)
  durationSec: number;
  /** Volume stats over the segment, sampled from polling. */
  volMinDb?: number;
  volMaxDb?: number;
  volAvgDb?: number;
  volLastDb?: number;
  samples: number;
  /** True while this segment is still the active one. */
  open?: boolean;
}

export interface UsageLog {
  current: UsageSegment | null;
  segments: UsageSegment[]; // most recent first
}

/** A captured track (metadata only — no audio). */
export interface TrackEntry {
  title: string;
  artist?: string;
  album?: string;
  service?: string;
  firstSeen: number;
  lastSeen: number;
  plays: number;
}

/** One BluOS browse menu item. */
export interface BrowseItem {
  text: string;
  type?: string; // link | audio | ...
  browseKey?: string; // present → drill in
  playURL?: string; // present → play
  image?: string;
}

export interface BrowseResult {
  serviceName?: string;
  items: BrowseItem[];
}

/** One entry in the current play queue. */
export interface QueueItem {
  title?: string;
  artist?: string;
  album?: string;
}

/** Fallback source labels when the device has not reported a name yet. */
export const DEFAULT_SOURCE_NAMES: Record<number, string> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [i + 1, `Source ${i + 1}`]),
);
