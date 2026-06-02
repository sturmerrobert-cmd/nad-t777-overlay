/**
 * Runtime capability discovery for the NAD V2.x ASCII protocol.
 *
 * The protocol is self-describing by omission: when you send `Key.Sub?` for a
 * variable the device does NOT implement, it simply stays silent (no error line,
 * no echo). So "did this key ever report a value?" is a reliable probe for
 * "does this model/firmware support this feature?".
 *
 * We send a probe `?` for every key below at connect time, then — after a short
 * discovery window — classify each capability:
 *   - supported   : at least one of its probe keys answered.
 *   - unsupported : window elapsed, no answer, and the key is NOT state-gated.
 *   - unknown     : window not yet elapsed, OR the key only answers in a certain
 *                   state (a locked input, the tuner being the active source…),
 *                   so silence does not prove absence.
 *
 * This lets ONE app adapt to any NAD on the shared protocol (T7xx/T5xx and the
 * later V2/V3 / MDC generation): the UI shows only what the device answered to.
 */

import { expandAliases } from './aliases.js';

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export interface CapabilitySpec {
  /** Stable id, mirrored in the web client. */
  id: string;
  /** Human label (English; UI may localise via i18n by id). */
  label: string;
  /** Representative keys; capability is supported if ANY answers. */
  keys: string[];
  /**
   * The key only answers in a particular device state (e.g. signal locked,
   * tuner active). Silence then yields `unknown`, never `unsupported`.
   */
  stateDependent?: boolean;
  /** Resolved externally (BluOS HTTP :11000, Dirac :5006) — not via the keys. */
  external?: 'bluos' | 'dirac';
}

/**
 * Capability catalog. Keys chosen to answer regardless of power state where
 * possible (config keys do; audio/video/tuner keys are state-gated).
 */
export const CAPABILITIES: CapabilitySpec[] = [
  { id: 'power', label: 'Power', keys: ['Main.Power'] },
  { id: 'volume', label: 'Master volume', keys: ['Main.Volume'] },
  { id: 'mute', label: 'Mute', keys: ['Main.Mute'] },
  { id: 'source', label: 'Source select', keys: ['Main.Source'] },
  { id: 'listeningMode', label: 'Listening mode', keys: ['Main.ListeningMode'] },
  { id: 'dimmer', label: 'Display dimmer', keys: ['Main.Dimmer'] },
  { id: 'sleep', label: 'Sleep timer', keys: ['Main.Sleep'] },
  // Source naming via `SourceN.Name` is a V2/V3-firmware addition; the original
  // T7xx/T5xx have no `.Name` query (sources are configured by input, not named).
  { id: 'sourceNames', label: 'Source names', keys: ['Source1.Name', 'Source2.Name'] },
  // Live decoded-signal readout (CODEC/rate/channels/lock) — V2/V3 firmware only,
  // and only answers when an input is locked, so state-gated.
  {
    id: 'signal',
    label: 'Live audio signal',
    keys: ['Main.Audio.CODEC', 'Main.Audio.Rate', 'Main.Audio.Lock', 'Main.Audio.SR'],
    stateDependent: true,
  },
  { id: 'videoRes', label: 'Video resolution', keys: ['Main.Video.Resolution'], stateDependent: true },
  { id: 'tone', label: 'Tone (bass/treble)', keys: ['Main.Bass', 'Main.Treble'] },
  { id: 'bassMgmt', label: 'Bass management', keys: ['Main.Speaker.Sub', 'Main.Level.Sub'] },
  { id: 'speakerConfig', label: 'Speaker config', keys: ['Main.Speaker.Front.Config'] },
  { id: 'dolby', label: 'Dolby parameters', keys: ['Main.Dolby.DRC', 'Main.Dolby.Panorama'] },
  { id: 'dts', label: 'DTS parameters', keys: ['Main.DTS.DRC', 'Main.DTS.DialogControl'] },
  // Auto power-off timer — a V2/V3 feature. NOT `Main.ControlStandby`, which is
  // a different first-gen setting ("allow Ethernet control while in standby").
  // First-gen has no auto-standby, so it correctly reports unsupported here.
  { id: 'autoStandby', label: 'Auto standby', keys: ['Main.AutoStandby'] },
  { id: 'osdTemp', label: 'OSD temp display', keys: ['Main.OSD.TempDisplay'] },
  { id: 'cec', label: 'HDMI CEC', keys: ['Main.CEC.Audio', 'Main.CEC.ARC'] },
  { id: 'triggers', label: '12V triggers', keys: ['Main.Trigger1.Out'] },
  { id: 'zone2', label: 'Zone 2', keys: ['Zone2.Power'] },
  { id: 'zone2VolMode', label: 'Zone 2 fixed/variable out', keys: ['Zone2.VolumeControl'] },
  { id: 'zone3', label: 'Zone 3', keys: ['Zone3.Power'] },
  { id: 'zone4', label: 'Zone 4', keys: ['Zone4.Power'] },
  // Tuner keys answer only while the tuner is the active source → state-gated.
  { id: 'tuner', label: 'Tuner', keys: ['Tuner.Band', 'Tuner.FM.Frequency'], stateDependent: true },
  // Multi-room / streaming module + room correction, discovered out-of-band.
  { id: 'bluos', label: 'BluOS streaming', keys: [], external: 'bluos' },
  { id: 'dirac', label: 'Dirac Live (:5006)', keys: [], external: 'dirac' },
];

/** Every probe key the client should query at connect (incl. alias spellings). */
export const CAPABILITY_PROBE_KEYS: string[] = expandAliases([
  ...new Set(CAPABILITIES.flatMap((c) => c.keys)),
]);

export type DeviceCapabilities = Record<string, CapabilityStatus>;

export interface CapabilityInputs {
  /** Has the discovery window elapsed? Before that, absence ⇒ `unknown`. */
  ready: boolean;
  /** BluOS HTTP API (:11000) responded. */
  bluos?: boolean;
  /** Dirac control port (:5006) is open. */
  dirac?: boolean;
  /** A source is named "Tuner" → tuner present even if not currently active. */
  tunerSourceIndex?: number;
}

/**
 * Classify every capability from the live key cache + out-of-band probes.
 * Pure: same inputs → same output.
 */
export function computeCapabilities(
  values: Map<string, string>,
  inputs: CapabilityInputs,
): DeviceCapabilities {
  const out: DeviceCapabilities = {};
  for (const cap of CAPABILITIES) {
    out[cap.id] = classify(cap, values, inputs);
  }
  return out;
}

function classify(
  cap: CapabilitySpec,
  values: Map<string, string>,
  inputs: CapabilityInputs,
): CapabilityStatus {
  if (cap.external === 'bluos') {
    return inputs.bluos ? 'supported' : inputs.ready ? 'unsupported' : 'unknown';
  }
  if (cap.external === 'dirac') {
    return inputs.dirac ? 'supported' : inputs.ready ? 'unsupported' : 'unknown';
  }
  // A source literally named "Tuner" proves the tuner exists even when idle.
  if (cap.id === 'tuner' && inputs.tunerSourceIndex !== undefined) return 'supported';

  const answered = cap.keys.some((k) => values.has(k));
  if (answered) return 'supported';
  if (!inputs.ready) return 'unknown';
  return cap.stateDependent ? 'unknown' : 'unsupported';
}
