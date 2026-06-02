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
  /** Raised when observed volume is above the cap (rule 5). */
  overCapAlert: boolean;
}

export interface AppState {
  nad: NadState;
  nowPlaying: NowPlaying;
  safety: VolumeSafety;
  /** Dirac REST API was absent in Phase 0 discovery; always false here. */
  diracAvailable: boolean;
  /** Last server-side warning/clamp message, surfaced to the UI. */
  lastNotice?: string;
  updatedAt: number;
}

/** Source index → display name. Editable in the UI later; sane defaults here. */
export const DEFAULT_SOURCE_NAMES: Record<number, string> = {
  1: 'Source 1',
  2: 'Source 2',
  3: 'Source 3',
  4: 'Source 4',
  5: 'Source 5',
  6: 'Source 6',
  7: 'Source 7',
  8: 'Source 8',
  9: 'Source 9',
  10: 'Source 10',
  11: 'Source 11',
  12: 'BluOS / Stream',
};
