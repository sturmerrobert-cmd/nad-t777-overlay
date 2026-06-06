// Mirrors apps/api/src/types.ts (the shape pushed over WebSocket / /api/state).

export interface NadState {
  reachable: boolean;
  model?: string;
  version?: string;
  power?: 'On' | 'Off';
  volumeDb?: number;
  mute?: boolean;
  source?: number;
  listeningMode?: string;
  dimmer?: string;
  sleepMinutes?: number;
  signal?: AudioSignal;
  tone?: ToneState;
  setup?: SetupState;
  surround?: SurroundState;
  system?: SystemState;
}

export interface AudioSignal {
  codec?: string;
  channels?: string;
  rateKhz?: string;
  lock?: string;
  delay?: string;
  videoResolution?: string;
}

export interface ToneState {
  bass?: number;
  treble?: number;
  toneDefeat?: boolean;
}

export interface SetupState {
  subOn?: boolean;
  enhancedBass?: boolean;
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
  volumeDb?: number;
  mute?: boolean;
  overCapAlert: boolean;
  volumeControl?: string;
  volumeFixed?: number;
}

export interface TunerState {
  active: boolean;
  band?: string;
  fmFrequency?: string;
  fmPreset?: string;
  mute?: boolean;
}

export interface NowPlaying {
  reachable: boolean;
  state?: string;
  title?: string;
  artist?: string;
  album?: string;
  imageUrl?: string;
  service?: string;
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
  overCapAlert: boolean;
}

export interface ChannelSafety {
  maxVolumeDb: number;
  maxStepDb: number;
  warnVolumeDb?: number;
  defaultVolumeDb?: number;
}

export interface UsageSegment {
  source: number;
  sourceName: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  volMinDb?: number;
  volMaxDb?: number;
  volAvgDb?: number;
  volLastDb?: number;
  samples: number;
  open?: boolean;
}

export interface UsageLog {
  current: UsageSegment | null;
  segments: UsageSegment[];
}

export interface TrackEntry {
  title: string;
  artist?: string;
  album?: string;
  service?: string;
  firstSeen: number;
  lastSeen: number;
  plays: number;
}

export interface BrowseItem {
  text: string;
  type?: string;
  browseKey?: string;
  playURL?: string;
  image?: string;
}

export interface BrowseResult {
  serviceName?: string;
  items: BrowseItem[];
}

export interface QueueItem {
  title?: string;
  artist?: string;
  album?: string;
}

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type DeviceCapabilities = Record<string, CapabilityStatus>;

export interface AppState {
  nad: NadState;
  zone2: Zone2State;
  tuner: TunerState;
  nowPlaying: NowPlaying;
  safety: VolumeSafety;
  zone2Safety: ChannelSafety;
  sourceNames: Record<string, string>;
  tunerSourceIndex?: number;
  bluosSourceIndex?: number;
  autoSwitchOnPlay: boolean;
  diracAvailable: boolean;
  capabilities: DeviceCapabilities;
  capabilitiesReady: boolean;
  lastNotice?: string;
  updatedAt: number;
}
