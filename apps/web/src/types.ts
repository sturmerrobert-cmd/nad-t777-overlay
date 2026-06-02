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
}

export interface AudioSignal {
  codec?: string;
  channels?: string;
  rateKhz?: string;
  lock?: string;
}

export interface Zone2State {
  power?: 'On' | 'Off';
  source?: number;
  volumeDb?: number;
  mute?: boolean;
  overCapAlert: boolean;
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

export interface AppState {
  nad: NadState;
  zone2: Zone2State;
  tuner: TunerState;
  nowPlaying: NowPlaying;
  safety: VolumeSafety;
  zone2Safety: ChannelSafety;
  sourceNames: Record<string, string>;
  tunerSourceIndex?: number;
  diracAvailable: boolean;
  lastNotice?: string;
  updatedAt: number;
}
