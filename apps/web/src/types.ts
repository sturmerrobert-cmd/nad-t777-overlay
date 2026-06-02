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

export interface AppState {
  nad: NadState;
  nowPlaying: NowPlaying;
  safety: VolumeSafety;
  diracAvailable: boolean;
  lastNotice?: string;
  updatedAt: number;
  sourceNames: Record<string, string>;
}
