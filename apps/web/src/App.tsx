import { useEffect, useRef, useState } from 'react';
import { api, fetchPresets, useLiveState, type ApiResult } from './api';
import type { AppState } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const NAD_FLOOR_DB = -80;

type TabId = 'main' | 'playing' | 'tuner' | 'zone2' | 'system';

const TABS: { id: TabId; label: string }[] = [
  { id: 'main', label: 'Główne' },
  { id: 'playing', label: 'Odtwarzanie' },
  { id: 'tuner', label: 'Tuner' },
  { id: 'zone2', label: 'Strefa 2' },
  { id: 'system', label: 'System' },
];

export function App() {
  const { state, connected } = useLiveState();
  const [tab, setTab] = useState<TabId>('main');

  return (
    <div className="app">
      <header className="topbar">
        <h1>NAD T 777 <span className="muted">overlay</span></h1>
        <ConnBadge connected={connected} state={state} />
      </header>

      {!state ? (
        <p className="muted">Connecting…</p>
      ) : (
        <>
          <SafetyStrip state={state} />
          {state.lastNotice && <div className="notice">⚠ {state.lastNotice}</div>}

          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'tuner' && !state.tuner.active && <span className="dot" title="inactive" />}
                {t.id === 'zone2' && state.zone2.overCapAlert && <span className="dot alert" title="over cap" />}
              </button>
            ))}
          </nav>

          <main className="panel">
            {tab === 'main' && <MainTab state={state} />}
            {tab === 'playing' && <PlayingTab state={state} />}
            {tab === 'tuner' && <TunerTab state={state} />}
            {tab === 'zone2' && <Zone2Tab state={state} />}
            {tab === 'system' && <SystemTab state={state} />}
          </main>
        </>
      )}
    </div>
  );
}

function ConnBadge({ connected, state }: { connected: boolean; state: AppState | null }) {
  const nad = state?.nad.reachable;
  return (
    <div className="badges">
      <span className={`badge ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'offline'}</span>
      <span className={`badge ${nad ? 'ok' : 'bad'}`}>NAD {nad ? 'OK' : '—'}</span>
      {state?.nad.model && <span className="badge dim">{state.nad.model} {state.nad.version}</span>}
    </div>
  );
}

function SafetyStrip({ state }: { state: AppState }) {
  const { safety, zone2, zone2Safety } = state;
  const alert = safety.overCapAlert || zone2.overCapAlert;
  return (
    <div className={`safety ${alert ? 'alert' : ''}`}>
      <strong>Volume safety</strong>
      <span>Main cap <b>{safety.maxVolumeDb} dB</b></span>
      <span>Zone 2 cap <b>{zone2Safety.maxVolumeDb} dB</b></span>
      <span>step ≤ {safety.maxStepDb} dB</span>
      {safety.warnVolumeDb !== undefined && <span>warn {safety.warnVolumeDb} dB</span>}
      <span>watchdog {safety.watchdog ? 'on' : 'off'}</span>
      {safety.overCapAlert && <span className="alert-text">⚠ Main {state.nad.volumeDb} dB above cap</span>}
      {zone2.overCapAlert && <span className="alert-text">⚠ Zone 2 {zone2.volumeDb} dB above {zone2Safety.maxVolumeDb}</span>}
    </div>
  );
}

/* ----------------------------- Reusable bits ----------------------------- */

function SourceGrid({
  current,
  names,
  onSelect,
}: {
  current?: number;
  names: Record<string, string>;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="sources">
      {Array.from({ length: 12 }, (_, i) => i + 1).map((idx) => (
        <button
          key={idx}
          className={`pill ${current === idx ? 'active' : ''}`}
          onClick={() => onSelect(idx)}
          title={`Source ${idx}`}
        >
          {names[String(idx)] ?? `Source ${idx}`}
        </button>
      ))}
    </div>
  );
}

/**
 * Guarded volume control, reused for Main and Zone 2. Reaching a far target
 * ramps in <= maxStep increments, each a separate guarded server command.
 */
function GuardedVolume({
  label,
  current,
  cap,
  maxStep,
  warnDb,
  defaultDb,
  overCap,
  stepFn,
}: {
  label: string;
  current?: number;
  cap: number;
  maxStep: number;
  warnDb?: number;
  defaultDb?: number;
  overCap: boolean;
  stepFn: (delta: number) => Promise<ApiResult>;
}) {
  const stepSmall = Math.min(2, maxStep);
  const initial = Math.min(current ?? defaultDb ?? cap, cap);
  const [target, setTarget] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const ramping = useRef(false);

  async function doStep(delta: number) {
    const r = await stepFn(round1(delta));
    setMsg(r.ok ? null : r.reason ?? 'rejected');
  }

  async function rampTo(to: number) {
    if (ramping.current || current === undefined) return;
    ramping.current = true;
    setBusy(true);
    let cur = current;
    try {
      while (Math.abs(cur - to) > 0.05) {
        const remaining = to - cur;
        const delta = Math.sign(remaining) * Math.min(Math.abs(remaining), maxStep);
        const r = await stepFn(round1(delta));
        if (!r.ok) { setMsg(r.reason ?? 'rejected'); break; }
        cur = r.targetDb ?? cur + delta;
        if (r.clamped) { setMsg(r.note ?? 'clamped to cap'); break; }
        await sleep(230);
      }
    } finally {
      ramping.current = false;
      setBusy(false);
    }
  }

  function commit(to: number) {
    const t = Math.min(to, cap);
    if (warnDb !== undefined && t > warnDb) setPending(t);
    else void rampTo(t);
  }

  return (
    <section className={`card volume ${overCap ? 'overcap' : ''}`}>
      <h2>{label} <span className="muted">(guarded)</span></h2>
      <div className="vol-readout">
        <span className="big">{current ?? '—'}</span><span className="unit">dB</span>
        {overCap && <span className="overcap-tag">above cap — app won’t raise it</span>}
      </div>

      <div className="row center">
        <button className="step" disabled={busy} onClick={() => doStep(-maxStep)}>−{maxStep}</button>
        <button className="step" disabled={busy} onClick={() => doStep(-stepSmall)}>−{stepSmall}</button>
        <button className="step" disabled={busy} onClick={() => doStep(+stepSmall)}>+{stepSmall}</button>
        <button className="step" disabled={busy} onClick={() => doStep(+maxStep)}>+{maxStep}</button>
      </div>

      <div className="slider-wrap">
        <input
          type="range"
          min={NAD_FLOOR_DB}
          max={cap}
          step={1}
          value={target}
          disabled={busy}
          onChange={(e) => setTarget(Number(e.target.value))}
          onMouseUp={() => commit(target)}
          onTouchEnd={() => commit(target)}
        />
        <div className="slider-labels">
          <span>{NAD_FLOOR_DB}</span>
          <span>target {target} dB</span>
          <span>cap {cap}</span>
        </div>
      </div>

      {pending !== null && (
        <div className="confirm">
          Set <b>{label}</b> to <b>{pending} dB</b> (above warn {warnDb} dB)?
          <button className="pill warn" onClick={() => { const t = pending; setPending(null); void rampTo(t); }}>Confirm</button>
          <button className="pill" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      {busy && <p className="muted">ramping in ≤{maxStep} dB steps…</p>}
      {msg && <p className="reject">⛔ {msg}</p>}
    </section>
  );
}

/* --------------------------------- Tabs --------------------------------- */

const LISTENING_MODES = ['None', 'Stereo', 'DolbySurround', 'DolbyDigital', 'DTS', 'EARS', 'EnhancedStereo', 'ProLogic'];

function signalLine(sig?: AppState['nad']['signal']): string {
  if (!sig) return '';
  const parts: string[] = [];
  if (sig.codec) parts.push(sig.codec);
  if (sig.channels) parts.push(`${sig.channels} ch`);
  if (sig.rateKhz) parts.push(`${sig.rateKhz} kHz`);
  if (sig.lock) parts.push(/^yes$/i.test(sig.lock) ? 'LOCK' : 'NO LOCK');
  return parts.join('  ·  ');
}

/** Skeuomorphic re-creation of the NAD T 777 front display (VFD style). */
function NadDisplay({ state }: { state: AppState }) {
  const { nad, nowPlaying } = state;
  const off = nad.power === 'Off';
  const srcName = nad.source ? state.sourceNames[String(nad.source)] ?? `Source ${nad.source}` : '—';
  const title = nowPlaying.reachable ? nowPlaying.title : undefined;
  const sig = signalLine(nad.signal);
  const dim = /on/i.test(nad.dimmer ?? '');

  return (
    <div className={`vfd ${off ? 'vfd-off' : ''} ${dim ? 'vfd-dim' : ''}`}>
      {off ? (
        <div className="vfd-row vfd-standby">STANDBY</div>
      ) : (
        <>
          <div className="vfd-row vfd-top">
            <span className="vfd-src">{nad.mute ? 'MUTE' : srcName}</span>
            <span className="vfd-vol">{nad.volumeDb ?? '—'} dB</span>
          </div>
          <div className="vfd-row vfd-mid">{title ?? nad.listeningMode ?? ''}</div>
          <div className="vfd-row vfd-bot">
            <span>{nad.listeningMode ?? ''}</span>
            <span className="vfd-sig">{sig}</span>
          </div>
        </>
      )}
    </div>
  );
}

function MainTab({ state }: { state: AppState }) {
  const { nad, safety } = state;
  const on = nad.power === 'On';
  return (
    <>
    <NadDisplay state={state} />
    <div className="grid">
      <section className="card">
        <h2>Power</h2>
        <div className="row">
          <button className={`pill ${on ? 'active' : ''}`} onClick={() => api.power(true)}>On</button>
          <button className={`pill ${!on ? 'active' : ''}`} onClick={() => api.power(false)}>Off</button>
          <button className={`pill ${nad.mute ? 'active warn' : ''}`} onClick={() => api.mute(!nad.mute)}>
            {nad.mute ? 'Muted' : 'Mute'}
          </button>
        </div>
      </section>

      <GuardedVolume
        label="Volume"
        current={nad.volumeDb}
        cap={safety.maxVolumeDb}
        maxStep={safety.maxStepDb}
        warnDb={safety.warnVolumeDb}
        defaultDb={safety.defaultVolumeDb}
        overCap={safety.overCapAlert}
        stepFn={api.volumeStep}
      />

      <section className="card">
        <h2>Source</h2>
        <SourceGrid current={nad.source} names={state.sourceNames} onSelect={api.source} />
      </section>

      <section className="card">
        <h2>Listening mode</h2>
        <div className="row wrap">
          {LISTENING_MODES.map((m) => (
            <button key={m} className={`pill ${nad.listeningMode === m ? 'active' : ''}`} onClick={() => api.listeningMode(m)}>{m}</button>
          ))}
        </div>
        {nad.listeningMode && <p className="muted">current: {nad.listeningMode}</p>}
      </section>

      <section className="card">
        <h2>Signal / quality</h2>
        <ul className="kv">
          <li><span>format (codec)</span><b>{nad.signal?.codec ?? '—'}</b></li>
          <li><span>channels</span><b>{nad.signal?.channels ?? '—'}</b></li>
          <li><span>sample rate</span><b>{nad.signal?.rateKhz ? `${nad.signal.rateKhz} kHz` : '—'}</b></li>
          <li><span>signal lock</span><b>{nad.signal?.lock ?? '—'}</b></li>
          <li><span>BluOS quality</span><b>{state.nowPlaying.quality ?? '—'}{state.nowPlaying.service ? ` · ${state.nowPlaying.service}` : ''}</b></li>
        </ul>
      </section>
    </div>
    </>
  );
}

function PlayingTab({ state }: { state: AppState }) {
  const np = state.nowPlaying;
  const [presets, setPresets] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => { void fetchPresets().then(setPresets); }, []);

  return (
    <div className="grid">
      <section className="card nowplaying">
        <h2>Now playing <span className="muted">(BluOS)</span></h2>
        {!np.reachable ? (
          <p className="muted">BluOS unreachable</p>
        ) : (
          <div className="np">
            {np.imageUrl && <img src={np.imageUrl} alt="" className="art" />}
            <div className="np-meta">
              <div className="np-title">{np.title ?? '—'}</div>
              <div className="np-sub">{np.artist}</div>
              <div className="np-sub dim">{np.album}</div>
              <div className="np-tags">
                {np.state && <span className="tag">{np.state}</span>}
                {np.service && <span className="tag">{np.service}</span>}
                {np.quality && <span className="tag">{np.quality}</span>}
              </div>
            </div>
          </div>
        )}
        <div className="row">
          <button className="pill" onClick={() => api.bluosTransport('back')}>⏮</button>
          <button className="pill" onClick={() => api.bluosTransport('play')}>▶</button>
          <button className="pill" onClick={() => api.bluosTransport('pause')}>⏸</button>
          <button className="pill" onClick={() => api.bluosTransport('skip')}>⏭</button>
        </div>
      </section>

      <section className="card">
        <h2>BluOS presets</h2>
        {presets.length === 0 ? (
          <p className="muted">No presets configured.</p>
        ) : (
          <div className="row wrap">
            {presets.map((p) => (
              <button key={p.id} className="pill" onClick={() => api.bluosPreset(p.id)}>{p.id}. {p.name}</button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function TunerTab({ state }: { state: AppState }) {
  const t = state.tuner;
  const tunerSrc = state.tunerSourceIndex;
  return (
    <div className="grid">
      <section className="card">
        <h2>Tuner</h2>
        {!t.active && (
          <div className="hint">
            Tuner controls respond only when the tuner is the active source.
            {tunerSrc && (
              <button className="pill" onClick={() => api.source(tunerSrc)} style={{ marginLeft: 8 }}>
                Switch to {state.sourceNames[String(tunerSrc)] ?? 'Tuner'}
              </button>
            )}
          </div>
        )}
        <div className="tuner-readout">
          <span className="big">{t.fmFrequency ?? '—'}</span>
          <span className="unit">{t.band ?? ''}</span>
        </div>
        <div className="row">
          <button className={`pill ${t.band === 'FM' ? 'active' : ''}`} disabled={!t.active} onClick={() => api.tunerBand('FM')}>FM</button>
          <button className={`pill ${t.band === 'AM' ? 'active' : ''}`} disabled={!t.active} onClick={() => api.tunerBand('AM')}>AM</button>
          <button className="pill" disabled={!t.active} onClick={() => api.tunerTune('down')}>◀ tune</button>
          <button className="pill" disabled={!t.active} onClick={() => api.tunerTune('up')}>tune ▶</button>
          <button className={`pill ${t.mute ? 'active warn' : ''}`} disabled={!t.active} onClick={() => api.tunerMute(!t.mute)}>
            {t.mute ? 'Muted' : 'Mute'}
          </button>
        </div>
        <h2 style={{ marginTop: 18 }}>FM presets</h2>
        <div className="row wrap">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button key={n} className={`pill ${t.fmPreset === String(n) ? 'active' : ''}`} disabled={!t.active} onClick={() => api.tunerPreset(n)}>P{n}</button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Per NAD V2.x reference (Tuner.Band / FM.Frequency / FM.Preset / FM.Mute). Not verified in Phase 0 — the tuner wasn’t the active source.
        </p>
      </section>
    </div>
  );
}

function Zone2Tab({ state }: { state: AppState }) {
  const z = state.zone2;
  const zs = state.zone2Safety;
  const on = z.power === 'On';
  return (
    <div className="grid">
      <section className="card">
        <h2>Zone 2 power</h2>
        <div className="row">
          <button className={`pill ${on ? 'active' : ''}`} onClick={() => api.zone2Power(true)}>On</button>
          <button className={`pill ${!on ? 'active' : ''}`} onClick={() => api.zone2Power(false)}>Off</button>
          <button className={`pill ${z.mute ? 'active warn' : ''}`} onClick={() => api.zone2Mute(!z.mute)}>
            {z.mute ? 'Muted' : 'Mute'}
          </button>
        </div>
      </section>

      <GuardedVolume
        label={`Zone 2 volume (cap ${zs.maxVolumeDb} dB)`}
        current={z.volumeDb}
        cap={zs.maxVolumeDb}
        maxStep={zs.maxStepDb}
        warnDb={zs.warnVolumeDb}
        defaultDb={zs.defaultVolumeDb}
        overCap={z.overCapAlert}
        stepFn={api.zone2VolumeStep}
      />

      <section className="card">
        <h2>Zone 2 source</h2>
        <SourceGrid current={z.source} names={state.sourceNames} onSelect={api.zone2Source} />
      </section>
    </div>
  );
}

function SystemTab({ state }: { state: AppState }) {
  const { nad, safety } = state;
  const dimOn = /on/i.test(nad.dimmer ?? '');
  const SLEEPS = [0, 15, 30, 45, 60, 90];
  return (
    <div className="grid">
      <section className="card">
        <h2>Display dimmer</h2>
        <div className="row">
          <button className={`pill ${dimOn ? 'active' : ''}`} onClick={() => api.dimmer(true)}>Dim On</button>
          <button className={`pill ${!dimOn ? 'active' : ''}`} onClick={() => api.dimmer(false)}>Dim Off</button>
        </div>
        <p className="muted">current: {nad.dimmer ?? '—'}</p>
      </section>

      <section className="card">
        <h2>Sleep timer</h2>
        <div className="row wrap">
          {SLEEPS.map((m) => (
            <button key={m} className={`pill ${nad.sleepMinutes === m ? 'active' : ''}`} onClick={() => api.sleep(m)}>
              {m === 0 ? 'Off' : `${m} min`}
            </button>
          ))}
        </div>
        <p className="muted">current: {nad.sleepMinutes === 0 || nad.sleepMinutes === undefined ? 'off' : `${nad.sleepMinutes} min`}</p>
      </section>

      <section className="card">
        <h2>Device</h2>
        <ul className="kv">
          <li><span>model</span><b>{nad.model ?? '—'}</b></li>
          <li><span>firmware</span><b>{nad.version ?? '—'}</b></li>
          <li><span>NAD link</span><b>{nad.reachable ? 'connected' : 'down'}</b></li>
          <li><span>Dirac (5006)</span><b>absent — panel disabled</b></li>
        </ul>
      </section>

      <section className="card">
        <h2>Volume safety</h2>
        <ul className="kv">
          <li><span>MAX_VOLUME_DB (Main)</span><b>{safety.maxVolumeDb} dB</b></li>
          <li><span>ZONE2_MAX_VOLUME_DB</span><b>{state.zone2Safety.maxVolumeDb} dB</b></li>
          <li><span>MAX_STEP_DB</span><b>{safety.maxStepDb} dB</b></li>
          <li><span>WARN_VOLUME_DB</span><b>{safety.warnVolumeDb ?? '—'}</b></li>
          <li><span>ZONE2_WARN_VOLUME_DB</span><b>{state.zone2Safety.warnVolumeDb ?? '—'}</b></li>
          <li><span>DEFAULT (UI)</span><b>{safety.defaultVolumeDb ?? '—'}</b></li>
          <li><span>CLAMP_ON_OBSERVED</span><b>{String(safety.clampOnObserved)}</b></li>
          <li><span>VOLUME_WATCHDOG</span><b>{String(safety.watchdog)}</b></li>
        </ul>
        <p className="muted">Main and Zone 2 each have their own cap. Watchdog would override the physical remote/knob — off by default.</p>
      </section>
    </div>
  );
}
