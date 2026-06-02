import { useRef, useState } from 'react';
import { api, useLiveState } from './api';
import type { AppState } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const NAD_FLOOR_DB = -80;

export function App() {
  const { state, connected } = useLiveState();

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
          <SafetyBanner state={state} />
          {state.lastNotice && <div className="notice">⚠ {state.lastNotice}</div>}
          <div className="grid">
            <PowerCard state={state} />
            <VolumeCard state={state} />
            <SourceCard state={state} />
            <ListeningModeCard state={state} />
            <NowPlayingCard state={state} />
          </div>
          <DiracDisabledNote />
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

function SafetyBanner({ state }: { state: AppState }) {
  const { safety, nad } = state;
  return (
    <div className={`safety ${safety.overCapAlert ? 'alert' : ''}`}>
      <strong>Volume safety</strong>
      <span>cap <b>{safety.maxVolumeDb} dB</b></span>
      <span>step ≤ {safety.maxStepDb} dB</span>
      {safety.warnVolumeDb !== undefined && <span>warn {safety.warnVolumeDb} dB</span>}
      <span>watchdog {safety.watchdog ? 'on' : 'off'}</span>
      {safety.overCapAlert && (
        <span className="alert-text">
          ⚠ current {nad.volumeDb} dB is ABOVE the cap
          {safety.clampOnObserved ? ' (auto pull-down on)' : ' — not auto-changed'}
        </span>
      )}
    </div>
  );
}

function PowerCard({ state }: { state: AppState }) {
  const on = state.nad.power === 'On';
  return (
    <section className="card">
      <h2>Power</h2>
      <div className="row">
        <button className={`pill ${on ? 'active' : ''}`} onClick={() => api.power(true)}>On</button>
        <button className={`pill ${!on ? 'active' : ''}`} onClick={() => api.power(false)}>Off</button>
        <button className={`pill ${state.nad.mute ? 'active warn' : ''}`} onClick={() => api.mute(!state.nad.mute)}>
          {state.nad.mute ? 'Muted' : 'Mute'}
        </button>
      </div>
    </section>
  );
}

function VolumeCard({ state }: { state: AppState }) {
  const { safety, nad } = state;
  const current = nad.volumeDb;
  const cap = safety.maxVolumeDb;
  const stepSmall = Math.min(2, safety.maxStepDb);
  const stepBig = safety.maxStepDb;

  // Slider target. Initial position = DEFAULT_VOLUME_DB (UI-only), never auto-sent.
  const initial = current ?? safety.defaultVolumeDb ?? cap;
  const [target, setTarget] = useState<number>(Math.min(initial, cap));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  const ramping = useRef(false);

  const note = (m: string | null) => setMsg(m);

  async function doStep(delta: number) {
    const res = await api.volumeStep(round1(delta));
    note(res.ok ? null : res.reason ?? 'rejected');
  }

  // Ramp toward `to` in <= maxStep increments (each a guarded server command).
  async function rampTo(to: number) {
    if (ramping.current || current === undefined) return;
    ramping.current = true;
    setBusy(true);
    let cur = current;
    try {
      while (Math.abs(cur - to) > 0.05) {
        const remaining = to - cur;
        const delta = Math.sign(remaining) * Math.min(Math.abs(remaining), stepBig);
        const res = await api.volumeStep(round1(delta));
        if (!res.ok) { note(res.reason ?? 'rejected'); break; }
        cur = res.targetDb ?? cur + delta;
        if (res.clamped) { note(res.note ?? 'clamped to cap'); break; }
        await sleep(230);
      }
    } finally {
      ramping.current = false;
      setBusy(false);
    }
  }

  function commit(to: number) {
    const clampedTarget = Math.min(to, cap);
    const needsConfirm = safety.warnVolumeDb !== undefined && clampedTarget > safety.warnVolumeDb;
    if (needsConfirm) {
      setPendingConfirm(clampedTarget);
    } else {
      void rampTo(clampedTarget);
    }
  }

  return (
    <section className="card volume">
      <h2>Volume <span className="muted">(guarded)</span></h2>
      <div className="vol-readout">
        <span className="big">{current ?? '—'}</span><span className="unit">dB</span>
      </div>

      <div className="row center">
        <button className="step" disabled={busy} onClick={() => doStep(-stepBig)}>−{stepBig}</button>
        <button className="step" disabled={busy} onClick={() => doStep(-stepSmall)}>−{stepSmall}</button>
        <button className="step" disabled={busy} onClick={() => doStep(+stepSmall)}>+{stepSmall}</button>
        <button className="step" disabled={busy} onClick={() => doStep(+stepBig)}>+{stepBig}</button>
      </div>

      <div className="slider-wrap">
        <input
          type="range"
          min={NAD_FLOOR_DB}
          max={cap}            /* slider cannot represent above the cap (G1 in UI) */
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

      {pendingConfirm !== null && (
        <div className="confirm">
          Set to <b>{pendingConfirm} dB</b> (above warn {safety.warnVolumeDb} dB)?
          <button className="pill warn" onClick={() => { const t = pendingConfirm; setPendingConfirm(null); void rampTo(t); }}>
            Confirm
          </button>
          <button className="pill" onClick={() => setPendingConfirm(null)}>Cancel</button>
        </div>
      )}

      {busy && <p className="muted">ramping in ≤{stepBig} dB steps…</p>}
      {msg && <p className="reject">⛔ {msg}</p>}
    </section>
  );
}

function SourceCard({ state }: { state: AppState }) {
  const names = state.sourceNames;
  const cur = state.nad.source;
  return (
    <section className="card">
      <h2>Source</h2>
      <div className="sources">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((idx) => (
          <button
            key={idx}
            className={`pill ${cur === idx ? 'active' : ''}`}
            onClick={() => api.source(idx)}
            title={`Source ${idx}`}
          >
            {names[String(idx)] ?? `Source ${idx}`}
          </button>
        ))}
      </div>
    </section>
  );
}

const LISTENING_MODES = ['None', 'Stereo', 'DolbySurround', 'DolbyDigital', 'DTS', 'EARS', 'EnhancedStereo', 'ProLogic'];

function ListeningModeCard({ state }: { state: AppState }) {
  const cur = state.nad.listeningMode;
  return (
    <section className="card">
      <h2>Listening mode</h2>
      <div className="row wrap">
        {LISTENING_MODES.map((m) => (
          <button key={m} className={`pill ${cur === m ? 'active' : ''}`} onClick={() => api.listeningMode(m)}>
            {m}
          </button>
        ))}
      </div>
      {cur && <p className="muted">current: {cur}</p>}
    </section>
  );
}

function NowPlayingCard({ state }: { state: AppState }) {
  const np = state.nowPlaying;
  return (
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
  );
}

function DiracDisabledNote() {
  return (
    <p className="dirac-note muted">
      Dirac panel disabled — REST API on port 5006 was absent during Phase 0 discovery on this unit.
    </p>
  );
}
