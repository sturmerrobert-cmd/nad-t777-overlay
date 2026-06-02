import { useEffect, useRef, useState } from 'react';
import {
  api, fetchPresets, fetchUsage, usageClear, fetchTracks, fetchBrowse, fetchQueue,
  useLiveState, type ApiResult,
} from './api';
import type { AppState, UsageLog, UsageSegment, TrackEntry, BrowseItem, BrowseResult, QueueItem } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const NAD_FLOOR_DB = -80;

type TabId = 'main' | 'audio' | 'playing' | 'library' | 'tuner' | 'zone2' | 'usage' | 'system';

const TABS: { id: TabId; label: string }[] = [
  { id: 'main', label: 'Główne' },
  { id: 'audio', label: 'Dźwięk' },
  { id: 'playing', label: 'Odtwarzanie' },
  { id: 'library', label: 'Biblioteka' },
  { id: 'tuner', label: 'Tuner' },
  { id: 'zone2', label: 'Strefa 2' },
  { id: 'usage', label: 'Log użycia' },
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
            {tab === 'audio' && <AudioTab state={state} />}
            {tab === 'playing' && <PlayingTab state={state} />}
            {tab === 'library' && <LibraryTab />}
            {tab === 'tuner' && <TunerTab state={state} />}
            {tab === 'zone2' && <Zone2Tab state={state} />}
            {tab === 'usage' && <UsageTab />}
            {tab === 'system' && <SystemTab state={state} />}
          </main>
        </>
      )}
    </div>
  );
}

function ConnBadge({ connected, state }: { connected: boolean; state: AppState | null }) {
  const nad = state?.nad.reachable;
  const bluos = state?.nowPlaying.reachable;
  return (
    <div className="badges">
      <span className={`badge ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'offline'}</span>
      <span className={`badge ${nad ? 'ok' : 'bad'}`}>NAD {nad ? 'OK' : '—'}</span>
      <span className={`badge ${bluos ? 'ok' : 'bad'}`} title={bluos ? '' : 'BluOS HTTP (port 11000) not responding — reboot the BluOS player'}>
        BluOS {bluos ? 'OK' : 'down'}
      </span>
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
        {state.bluosSourceIndex && state.nad.source !== state.bluosSourceIndex && (
          <button className="big-action" style={{ marginTop: 12 }} onClick={() => api.bluosActivate()}>
            ▶ Play on NAD (BluOS)
          </button>
        )}
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
          <li><span>video</span><b>{nad.signal?.videoResolution || '—'}</b></li>
          <li><span>A/V delay</span><b>{nad.signal?.delay ?? '—'}</b></li>
          <li><span>BluOS quality</span><b>{state.nowPlaying.quality ?? '—'}{state.nowPlaying.service ? ` · ${state.nowPlaying.service}` : ''}</b></li>
        </ul>
      </section>
    </div>
    </>
  );
}

function BluosModuleCard({ reachable }: { reachable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reboot() {
    if (!confirm('Reboot the BluOS module? Playback will stop and it will be unavailable for ~1–2 min.')) return;
    setBusy(true); setMsg(null);
    const r = (await api.bluosReboot()) as { ok: boolean; detail?: string; reason?: string };
    setBusy(false);
    setMsg(r.detail ?? r.reason ?? (r.ok ? 'Reboot requested.' : 'Failed.'));
  }

  return (
    <section className="card">
      <h2>BluOS module</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${reachable ? 'ok' : 'bad'}`}>{reachable ? 'BluOS OK' : 'BluOS down'}</span>
        <button className="pill" onClick={reboot} disabled={busy}>↻ Try remote reboot</button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Verified on this unit: BluOS exposes <b>no remote-reboot API</b> (the reboot path returns 404).
        To reboot the module:
      </p>
      <ul className="muted" style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>
        <li><b>BluOS app</b> → Settings → Players → your player → <b>Reboot</b>, or</li>
        <li><b>Rear-panel power-cycle</b> (off ~30–60 s, then on) — needed if BluOS is hung/“down”.</li>
      </ul>
      {msg && <p className={msg.toLowerCase().includes('reboot requested') ? 'muted' : 'reject'}>{msg}</p>}
    </section>
  );
}

function PlayingTab({ state }: { state: AppState }) {
  const np = state.nowPlaying;
  const [presets, setPresets] = useState<Array<{ id: number; name: string }>>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  useEffect(() => { void fetchPresets().then(setPresets); }, []);
  useEffect(() => {
    const tick = () => { void fetchQueue().then(setQueue); };
    tick(); const id = setInterval(tick, 4000); return () => clearInterval(id);
  }, []);

  const bluosIdx = state.bluosSourceIndex;
  const onBluos = state.nad.source !== undefined && state.nad.source === bluosIdx;
  const playing = /^(play|stream)/i.test(np.state ?? '');

  return (
    <div className="grid">
      <section className="card">
        <h2>Play through the NAD</h2>
        <button className="big-action" onClick={() => api.bluosActivate()} disabled={!bluosIdx}>
          ▶ Play on NAD now
        </button>
        <div className="row" style={{ margin: '10px 0' }}>
          <span className={`badge ${onBluos ? 'ok' : 'dim'}`}>
            {onBluos ? 'on BluOS' : `source: ${state.nad.source ? state.sourceNames[String(state.nad.source)] ?? state.nad.source : '—'}`}
          </span>
          {playing && <span className="badge ok">streaming</span>}
        </div>
        <p className="muted">
          One click: powers on, switches to BluOS{bluosIdx ? ` (source ${bluosIdx})` : ''}, and resumes the
          stream (Spotify). Volume is never changed. You don’t even need to touch Spotify — selecting
          BluOS resumes the last session.
        </p>
        <ToggleSettingRaw
          label="Auto-switch to BluOS when playback starts (+power on)"
          on={state.autoSwitchOnPlay}
          onSet={(v) => api.autoswitch(v)}
        />
        <p className="muted" style={{ fontSize: 12 }}>
          Note: when the receiver is on another source it reports BluOS as “External Source”, so it can’t
          see a Spotify start from there — auto-switch only catches cases where BluOS itself reports
          playing. The button above is the reliable way.
        </p>
        {!bluosIdx && <p className="reject">⚠ No source named “BluOS” found on the receiver — can’t target it.</p>}
      </section>

      <BluosModuleCard reachable={!!np.reachable} />

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

      <section className="card">
        <h2>Queue <span className="muted">(current play queue)</span></h2>
        {queue.length === 0 ? (
          <p className="muted">Queue is empty (or the streamer is in endpoint mode, e.g. Spotify Connect).</p>
        ) : (
          <ol className="queue">
            {queue.slice(0, 50).map((q, i) => (
              <li key={i}><b>{q.title ?? '—'}</b>{q.artist ? <span className="muted"> — {q.artist}</span> : null}</li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function LibraryTab() {
  // Browse navigator: a stack of {key,label} crumbs.
  const [crumbs, setCrumbs] = useState<{ key?: string; label: string }[]>([{ label: 'BluOS' }]);
  const [res, setRes] = useState<BrowseResult>({ items: [] });
  const [loading, setLoading] = useState(false);
  const [tracks, setTracks] = useState<TrackEntry[]>([]);

  const current = crumbs[crumbs.length - 1]!;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void fetchBrowse(current.key).then((r) => { if (alive) { setRes(r); setLoading(false); } });
    return () => { alive = false; };
  }, [current.key]);

  const reloadTracks = () => { void fetchTracks(1000).then(setTracks); };
  useEffect(() => { reloadTracks(); const id = setInterval(reloadTracks, 5000); return () => clearInterval(id); }, []);

  function open(item: BrowseItem) {
    if (item.browseKey) setCrumbs([...crumbs, { key: item.browseKey, label: item.text }]);
    else if (item.playURL) void api.bluosPlayUrl(item.playURL);
  }
  function goto(i: number) { setCrumbs(crumbs.slice(0, i + 1)); }

  return (
    <div className="grid">
      <section className="card">
        <h2>Browse BluOS <span className="muted">(radio · playlists · services · local library)</span></h2>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb" onClick={() => goto(i)}>{c.label}</button>
            </span>
          ))}
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : res.items.length === 0 ? (
          <p className="muted">
            Nothing here. BluOS only lists content when it’s active — start playing (or pick a source
            with a library/radio). When you connect a NAS/USB, your local music shows up here too.
          </p>
        ) : (
          <div className="browse-list">
            {res.items.map((it, i) => (
              <button key={i} className={`browse-item ${it.playURL ? 'audio' : 'link'}`} onClick={() => open(it)}>
                <span className="bi-text">{it.text}</span>
                <span className="bi-act">{it.playURL ? '▶ play' : it.browseKey ? '›' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="usage-head">
          <h2>My track list <span className="muted">(what you heard — for buying/finding)</span></h2>
          <span className="seg">
            <a className="pill" href="/api/tracks/export.csv" download>Export CSV</a>
            <button className="pill" onClick={() => { if (confirm('Clear the captured track list?')) void api.tracksClear().then(reloadTracks); }}>Clear</button>
          </span>
        </div>
        <p className="muted">
          {tracks.length} distinct tracks captured from now-playing (titles/artists only — no audio).
          This is a legal “shopping list”; buy the files (Bandcamp/Qobuz/7digital) or add them to a NAS
          and BluOS plays them locally.
        </p>
        {tracks.length === 0 ? (
          <p className="muted">Nothing captured yet — play some music and tracks will appear here.</p>
        ) : (
          <div className="table-wrap">
            <table className="usage">
              <thead><tr><th>Title</th><th>Artist</th><th>Album</th><th>Service</th><th>Plays</th></tr></thead>
              <tbody>
                {tracks.map((t, i) => (
                  <tr key={i}>
                    <td><b>{t.title}</b></td>
                    <td>{t.artist ?? '—'}</td>
                    <td className="muted">{t.album ?? '—'}</td>
                    <td>{t.service ?? '—'}</td>
                    <td className="num">{t.plays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      <section className="card">
        <h2>Zone 2 output mode</h2>
        <EnumSetting label="Volume control" k="Zone2.VolumeControl" value={z.volumeControl} options={['Variable', 'Fixed']} />
        <ul className="kv" style={{ marginTop: 8 }}>
          <li><span>fixed level</span><b>{z.volumeFixed ?? '—'} dB</b></li>
        </ul>
        {z.volumeControl === 'Fixed' && (
          <p className="reject">⚠ Fixed mode outputs at {z.volumeFixed ?? '—'} dB regardless of the Zone 2 volume control — and is NOT bounded by the Zone 2 cap. Use with care.</p>
        )}
      </section>
    </div>
  );
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function UsageRow({ seg }: { seg: UsageSegment }) {
  return (
    <tr className={seg.open ? 'usage-open' : ''}>
      <td>
        <b>{seg.sourceName}</b> <span className="muted">#{seg.source}</span>
        {seg.open && <span className="live-dot" title="active" />}
      </td>
      <td className="num">{fmtDay(seg.startedAt)} {fmtClock(seg.startedAt)}</td>
      <td className="num">{seg.open ? '— now' : fmtClock(seg.endedAt)}</td>
      <td className="num">{fmtDur(seg.durationSec)}</td>
      <td className="num">{seg.volAvgDb ?? '—'}</td>
      <td className="num muted">{seg.volMinDb ?? '—'} / {seg.volMaxDb ?? '—'}</td>
    </tr>
  );
}

function UsageTab() {
  const [log, setLog] = useState<UsageLog>({ current: null, segments: [] });

  useEffect(() => {
    let alive = true;
    const tick = () => { void fetchUsage(300).then((l) => { if (alive) setLog(l); }); };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const rows = log.current ? [log.current, ...log.segments] : log.segments;
  const totalSec = log.segments.reduce((a, s) => a + s.durationSec, 0) + (log.current?.durationSec ?? 0);

  return (
    <div className="grid one">
      <section className="card">
        <div className="usage-head">
          <h2>Usage log <span className="muted">(from polling · source · time · volume)</span></h2>
          <button
            className="pill"
            onClick={() => { if (confirm('Clear the usage log?')) void usageClear().then(() => fetchUsage(300).then(setLog)); }}
          >
            Clear
          </button>
        </div>
        <p className="muted">
          {log.segments.length} past segments · ~{fmtDur(totalSec)} tracked total. Sampled each poll
          (~1.5 s); a new segment starts when the source changes or power toggles.
        </p>
        {rows.length === 0 ? (
          <p className="muted">No usage recorded yet — switch sources or change volume and it will appear here.</p>
        ) : (
          <div className="table-wrap">
            <table className="usage">
              <thead>
                <tr>
                  <th>Source</th><th>Started</th><th>Ended</th><th>Duration</th>
                  <th>Avg dB</th><th>Min / Max</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => <UsageRow key={`${s.source}-${s.startedAt}-${i}`} seg={s} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---- Generic setting controls (bound to allowlisted /api/setting) ----
 *
 * These are OPTIMISTIC: clicking updates the shown value instantly and (for
 * steppers) accumulates locally, while the device value only echoes back ~1.5s
 * later via polling. Incoming live values are adopted only when the user hasn't
 * touched the control recently, so polling never "fights" an in-progress edit.
 */

const ADOPT_AFTER_MS = 1600; // ignore incoming live value this long after a click

/** Optimistic value that syncs from `incoming` unless recently edited locally. */
function useOptimistic<T>(incoming: T): [T, (v: T) => void, { current: number }] {
  const [val, setVal] = useState<T>(incoming);
  const ref = useRef<T>(incoming);
  const editedAt = useRef(0);
  useEffect(() => {
    if (Date.now() - editedAt.current > ADOPT_AFTER_MS) {
      ref.current = incoming;
      setVal(incoming);
    }
  }, [incoming]);
  const set = (v: T) => { ref.current = v; setVal(v); editedAt.current = Date.now(); };
  return [val, set, editedAt];
}

function ToggleSetting({ label, k, on }: { label: string; k: string; on?: boolean }) {
  const [local, setLocal] = useOptimistic(on);
  const set = (v: boolean) => { setLocal(v); void api.setting(k, v); };
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="seg">
        <button className={`pill ${local ? 'active' : ''}`} onClick={() => set(true)}>On</button>
        <button className={`pill ${local === false ? 'active' : ''}`} onClick={() => set(false)}>Off</button>
      </span>
    </div>
  );
}

function ToggleSettingRaw({ label, on, onSet }: { label: string; on?: boolean; onSet: (v: boolean) => void }) {
  const [local, setLocal] = useOptimistic(on);
  const set = (v: boolean) => { setLocal(v); onSet(v); };
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="seg">
        <button className={`pill ${local ? 'active' : ''}`} onClick={() => set(true)}>On</button>
        <button className={`pill ${local === false ? 'active' : ''}`} onClick={() => set(false)}>Off</button>
      </span>
    </div>
  );
}

function IntSetting({
  label, k, value, unit, step = 1, min, max,
}: { label: string; k: string; value?: number; unit?: string; step?: number; min?: number; max?: number }) {
  const [local, setLocal, editedAt] = useOptimistic(value);
  const sendTimer = useRef<ReturnType<typeof setTimeout>>();

  function bump(delta: number) {
    const base = local ?? value ?? 0;
    let next = base + delta;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (next === base) return;
    setLocal(next);
    editedAt.current = Date.now();
    // Debounce the network write so a burst of clicks sends one absolute value.
    clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => { void api.setting(k, next); }, 160);
  }

  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="seg">
        <button className="step sm" onClick={() => bump(-step)}>−</button>
        <b className="setting-val">{local ?? '—'}{unit ? ` ${unit}` : ''}</b>
        <button className="step sm" onClick={() => bump(+step)}>+</button>
      </span>
    </div>
  );
}

function EnumSetting({ label, k, value, options }: { label: string; k: string; value?: string; options: string[] }) {
  const [local, setLocal] = useOptimistic(value);
  const set = (o: string) => { setLocal(o); void api.setting(k, o); };
  return (
    <div className="setting-row">
      <span>{label}</span>
      <span className="seg">
        {options.map((o) => (
          <button key={o} className={`pill ${local === o ? 'active' : ''}`} onClick={() => set(o)}>{o}</button>
        ))}
      </span>
    </div>
  );
}

function AudioTab({ state }: { state: AppState }) {
  const t = state.nad.tone ?? {};
  const s = state.nad.setup ?? {};
  const sur = state.nad.surround ?? {};
  return (
    <div className="grid">
      <section className="card">
        <h2>Tone</h2>
        <IntSetting label="Bass" k="Main.Bass" value={t.bass} unit="dB" min={-10} max={10} />
        <IntSetting label="Treble" k="Main.Treble" value={t.treble} unit="dB" min={-10} max={10} />
        <ToggleSetting label="Tone defeat (bypass)" k="Main.ToneDefeat" on={t.toneDefeat} />
      </section>

      <section className="card">
        <h2>Bass management & levels</h2>
        <ToggleSetting label="Subwoofer" k="Main.Speaker.Sub" on={s.subOn} />
        <ToggleSetting label="Enhanced bass" k="Main.EnhancedBass" on={s.enhancedBass} />
        <IntSetting label="Center level" k="Main.Level.Center" value={s.levelCenter} unit="dB" min={-12} max={12} />
        <IntSetting label="Sub level" k="Main.Level.Sub" value={s.levelSub} unit="dB" min={-12} max={12} />
        <IntSetting label="Center dialog" k="Main.CenterDialog" value={s.centerDialog} min={0} max={6} />
      </section>

      <section className="card">
        <h2>Speaker config</h2>
        <EnumSetting label={`Front (xover ${s.frontFreq ?? '—'} Hz)`} k="Main.Speaker.Front.Config" value={s.frontConfig} options={['Large', 'Small']} />
        <EnumSetting label={`Center (xover ${s.centerFreq ?? '—'} Hz)`} k="Main.Speaker.Center.Config" value={s.centerConfig} options={['Large', 'Small']} />
        <EnumSetting label={`Surround (xover ${s.surroundFreq ?? '—'} Hz)`} k="Main.Speaker.Surround.Config" value={s.surroundConfig} options={['Large', 'Small']} />
        <p className="muted">Crossover frequencies are shown read-only.</p>
      </section>

      <section className="card">
        <h2>Surround params</h2>
        <ToggleSetting label="Dolby Center Spread" k="Main.Dolby.CenterSpread" on={sur.dolbyCenterSpread} />
        <ToggleSetting label="Dolby Panorama" k="Main.Dolby.Panorama" on={sur.dolbyPanorama} />
        <ul className="kv" style={{ marginTop: 10 }}>
          <li><span>Dolby Center Width</span><b>{sur.dolbyCenterWidth ?? '—'}</b></li>
          <li><span>Dolby DRC</span><b>{sur.dolbyDrc ?? '—'}</b></li>
          <li><span>Dolby Dimension</span><b>{sur.dolbyDimension ?? '—'}</b></li>
          <li><span>DTS Center Gain</span><b>{sur.dtsCenterGain ?? '—'}</b></li>
          <li><span>DTS DRC</span><b>{sur.dtsDrc ?? '—'}</b></li>
          <li><span>DTS Dialog Control</span><b>{sur.dtsDialogControl ?? '—'}</b></li>
        </ul>
        <p className="muted">Listening-mode fine-tuning, shown read-only (toggles above are settable).</p>
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
        <h2>Standby & display</h2>
        <ToggleSetting label="Auto standby" k="Main.AutoStandby" on={nad.system?.autoStandby} />
        <ToggleSetting label="OSD temp display" k="Main.OSD.TempDisplay" on={nad.system?.osdTempDisplay} />
      </section>

      <section className="card">
        <h2>HDMI CEC</h2>
        <EnumSetting label="ARC" k="Main.CEC.ARC" value={nad.system?.cecArc} options={['Auto', 'On', 'Off']} />
        <ToggleSetting label="CEC audio" k="Main.CEC.Audio" on={nad.system?.cecAudio} />
        <ToggleSetting label="CEC switch" k="Main.CEC.Switch" on={nad.system?.cecSwitch} />
        <ToggleSetting label="CEC power" k="Main.CEC.Power" on={nad.system?.cecPower} />
      </section>

      <section className="card">
        <h2>Device</h2>
        <ul className="kv">
          <li><span>model</span><b>{nad.model ?? '—'}</b></li>
          <li><span>firmware</span><b>{nad.version ?? '—'}</b></li>
          <li><span>NAD link</span><b>{nad.reachable ? 'connected' : 'down'}</b></li>
          <li><span>trigger 1 / 2 out</span><b>{nad.system?.trigger1Out ?? '—'} / {nad.system?.trigger2Out ?? '—'}</b></li>
          <li><span>video resolution</span><b>{nad.signal?.videoResolution || '—'}</b></li>
          <li><span>A/V delay</span><b>{nad.signal?.delay ?? '—'}</b></li>
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
