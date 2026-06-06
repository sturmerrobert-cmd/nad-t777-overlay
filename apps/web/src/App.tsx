import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, fetchPresets, fetchUsage, usageClear, fetchTracks, fetchBrowse, fetchQueue,
  useLiveState, type ApiResult,
} from './api';
import type { AppState, CapabilityStatus, UsageLog, UsageSegment, TrackEntry, BrowseItem, BrowseResult, QueueItem } from './types';
import { t, getLang, setLang, LANGS, manual, type Lang } from './i18n';
import { PRODUCT_NAME, DIRAC_ENABLED } from './branding';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const NAD_FLOOR_DB = -80;

/* ----------------------- Runtime capability gating ----------------------- */

/** Status of a discovered capability ('unknown' until discovery completes). */
function capOf(state: AppState, id: string): CapabilityStatus {
  return state.capabilities?.[id] ?? 'unknown';
}
/** Only `unsupported` hides/locks a feature; `unknown` stays usable. */
function unsupported(state: AppState, id: string): boolean {
  return capOf(state, id) === 'unsupported';
}
/** True if ALL listed capabilities are definitively unsupported. */
function allUnsupported(state: AppState, ids: string[]): boolean {
  return ids.length > 0 && ids.every((id) => unsupported(state, id));
}

/** Tab → capabilities that justify showing it (any supported/unknown keeps it). */
const TAB_CAPS: Partial<Record<TabId, string[]>> = {
  audio: ['tone', 'bassMgmt', 'speakerConfig', 'dolby', 'dts'],
  playing: ['bluos'],
  library: ['bluos'],
  tuner: ['tuner'],
  zone2: ['zone2'],
};

/** Human ordering + grouping for the compatibility panel. */
const CAP_LABELS: { id: string; label: string }[] = [
  { id: 'power', label: 'Power' },
  { id: 'volume', label: 'Master volume' },
  { id: 'mute', label: 'Mute' },
  { id: 'source', label: 'Source select' },
  { id: 'sourceNames', label: 'Source names' },
  { id: 'listeningMode', label: 'Listening mode' },
  { id: 'signal', label: 'Live audio signal' },
  { id: 'videoRes', label: 'Video resolution' },
  { id: 'tone', label: 'Tone (bass/treble)' },
  { id: 'bassMgmt', label: 'Bass management' },
  { id: 'speakerConfig', label: 'Speaker config' },
  { id: 'dolby', label: 'Dolby parameters' },
  { id: 'dts', label: 'DTS parameters' },
  { id: 'dimmer', label: 'Display dimmer' },
  { id: 'sleep', label: 'Sleep timer' },
  { id: 'autoStandby', label: 'Auto standby' },
  { id: 'osdTemp', label: 'OSD temp display' },
  { id: 'cec', label: 'HDMI CEC' },
  { id: 'triggers', label: '12V triggers' },
  { id: 'zone2', label: 'Zone 2' },
  { id: 'zone3', label: 'Zone 3' },
  { id: 'zone4', label: 'Zone 4' },
  { id: 'tuner', label: 'Tuner' },
  // id stays 'bluos' (internal backend capability id); only the label is generic.
  { id: 'bluos', label: 'Streaming' },
  // Dirac listed only when explicitly enabled (off by default — see branding.ts).
  ...(DIRAC_ENABLED ? [{ id: 'dirac', label: 'Dirac' }] : []),
];

function CapBadge({ status }: { status: CapabilityStatus }) {
  const cls = status === 'supported' ? 'ok' : status === 'unsupported' ? 'bad' : 'dim';
  const label = status === 'supported' ? t('cap.yes') : status === 'unsupported' ? t('cap.no') : t('cap.maybe');
  return <span className={`badge ${cls}`}>{label}</span>;
}

/** Wrap a feature card; greys it out + shows a note when unsupported. */
function Gate({ state, cap, children }: { state: AppState; cap: string; children: ReactNode }) {
  if (unsupported(state, cap)) {
    return (
      <div className="gate-off">
        {children}
        <div className="gate-overlay">{t('cap.unsupported')}</div>
      </div>
    );
  }
  return <>{children}</>;
}

type TabId = 'main' | 'audio' | 'playing' | 'library' | 'tuner' | 'zone2' | 'usage' | 'system' | 'help';

const TABS: { id: TabId; key: string }[] = [
  { id: 'main', key: 'tab.main' },
  { id: 'audio', key: 'tab.audio' },
  { id: 'playing', key: 'tab.playing' },
  { id: 'library', key: 'tab.library' },
  { id: 'tuner', key: 'tab.tuner' },
  { id: 'zone2', key: 'tab.zone2' },
  { id: 'usage', key: 'tab.usage' },
  { id: 'system', key: 'tab.system' },
  { id: 'help', key: 'tab.help' },
];

export function App() {
  const { state, connected } = useLiveState();
  const [tab, setTab] = useState<TabId>('main');
  const [, setLangTick] = useState<Lang>(getLang());
  const changeLang = (l: Lang) => { setLang(l); setLangTick(l); };
  useEffect(() => { document.title = PRODUCT_NAME; }, []);

  // If the active tab becomes unsupported (device swapped/discovered), fall back.
  const tabHidden = !!state && !!TAB_CAPS[tab] && allUnsupported(state, TAB_CAPS[tab]!);
  useEffect(() => { if (tabHidden) setTab('main'); }, [tabHidden]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>{PRODUCT_NAME}</h1>
        <div className="topbar-right">
          <ConnBadge connected={connected} state={state} />
          <div className="lang-switch">
            {LANGS.map((l) => (
              <button key={l.id} className={`lang ${getLang() === l.id ? 'active' : ''}`} onClick={() => changeLang(l.id)}>{l.label}</button>
            ))}
          </div>
        </div>
      </header>

      {!state ? (
        <p className="muted">{t('app.connecting')}</p>
      ) : (
        <>
          <FirstRunNotice />
          <SafetyStrip state={state} />
          {state.lastNotice && <div className="notice">⚠ {state.lastNotice}</div>}

          <nav className="tabs">
            {TABS.filter((tb) => !(TAB_CAPS[tb.id] && allUnsupported(state, TAB_CAPS[tb.id]!))).map((tb) => (
              <button
                key={tb.id}
                className={`tab ${tab === tb.id ? 'active' : ''}`}
                onClick={() => setTab(tb.id)}
              >
                {t(tb.key)}
                {tb.id === 'tuner' && !state.tuner.active && <span className="dot" title="inactive" />}
                {tb.id === 'zone2' && state.zone2.overCapAlert && <span className="dot alert" title="over cap" />}
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
            {tab === 'help' && <HelpTab />}
          </main>
        </>
      )}
    </div>
  );
}

/** One-time notice (volume safety + independence/trademark) shown on first launch. */
function FirstRunNotice() {
  const KEY = 'rhq.firstrun.ack';
  const [ack, setAck] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  if (ack) return null;
  const dismiss = () => { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } setAck(true); };
  return (
    <div className="firstrun">
      <strong>{t('firstrun.title')}</strong>
      <p>{t('firstrun.body')}</p>
      <button className="pill warn" onClick={dismiss}>{t('firstrun.ack')}</button>
    </div>
  );
}

/** About: product identity + descriptive compatibility + trademark disclaimer + notices. */
function AboutCard() {
  return (
    <section className="card">
      <h2>{t('about.title')} <span className="muted">{PRODUCT_NAME}</span></h2>
      <p>{t('about.compat')}</p>
      <p className="muted" style={{ fontSize: 13 }}>{t('about.disclaimer')}</p>
      <p className="muted" style={{ fontSize: 12 }}>{t('about.notices')}</p>
    </section>
  );
}

function ConnBadge({ connected, state }: { connected: boolean; state: AppState | null }) {
  const nad = state?.nad.reachable;
  const bluos = state?.nowPlaying.reachable;
  return (
    <div className="badges">
      <span className={`badge ${connected ? 'ok' : 'bad'}`}>{connected ? t('badge.live') : t('badge.offline')}</span>
      <span className={`badge ${nad ? 'ok' : 'bad'}`}>{t('badge.receiver')} {nad ? 'OK' : '—'}</span>
      <span className={`badge ${bluos ? 'ok' : 'bad'}`} title={bluos ? '' : t('badge.streamDownHint')}>
        {t('badge.streaming')} {bluos ? 'OK' : t('badge.down')}
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
      <strong>{t('safety.title')}</strong>
      <span>{t('safety.mainCap')} <b>{safety.maxVolumeDb} dB</b></span>
      <span>{t('safety.zone2Cap')} <b>{zone2Safety.maxVolumeDb} dB</b></span>
      <span>{t('safety.step', { n: safety.maxStepDb })}</span>
      {safety.warnVolumeDb !== undefined && <span>{t('safety.warn', { n: safety.warnVolumeDb })}</span>}
      <span>{t('safety.watchdog', { s: safety.watchdog ? t('common.on') : t('common.off') })}</span>
      {safety.overCapAlert && <span className="alert-text">{t('safety.mainOver', { v: state.nad.volumeDb ?? '?' })}</span>}
      {zone2.overCapAlert && <span className="alert-text">{t('safety.zone2Over', { v: zone2.volumeDb ?? '?', cap: zone2Safety.maxVolumeDb })}</span>}
    </div>
  );
}

/* ----------------------------- Reusable bits ----------------------------- */

function SourceGrid({
  current, names, onSelect,
}: { current?: number; names: Record<string, string>; onSelect: (i: number) => void }) {
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

/** Guarded volume control, reused for Main and Zone 2. */
function GuardedVolume({
  label, current, cap, maxStep, warnDb, defaultDb, overCap, stepFn,
}: {
  label: string; current?: number; cap: number; maxStep: number;
  warnDb?: number; defaultDb?: number; overCap: boolean; stepFn: (delta: number) => Promise<ApiResult>;
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
    const tv = Math.min(to, cap);
    if (warnDb !== undefined && tv > warnDb) setPending(tv);
    else void rampTo(tv);
  }

  return (
    <section className={`card volume ${overCap ? 'overcap' : ''}`}>
      <h2>{label} <span className="muted">{t('vol.guarded')}</span></h2>
      <div className="vol-readout">
        <span className="big">{current ?? '—'}</span><span className="unit">dB</span>
        {overCap && <span className="overcap-tag">{t('vol.overcap')}</span>}
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
          <span>{t('vol.target', { v: target })}</span>
          <span>{t('vol.cap', { v: cap })}</span>
        </div>
      </div>

      {pending !== null && (
        <div className="confirm">
          {t('vol.confirm', { label, v: pending, w: warnDb ?? '?' })}
          <button className="pill warn" onClick={() => { const tv = pending; setPending(null); void rampTo(tv); }}>{t('common.confirm')}</button>
          <button className="pill" onClick={() => setPending(null)}>{t('common.cancel')}</button>
        </div>
      )}
      {busy && <p className="muted">{t('vol.ramping', { n: maxStep })}</p>}
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

/**
 * Resolve what a configured NAD VFD line shows to its live text, so the panel
 * mirrors the front display exactly (per Main.VFD.Line1 / Main.VFD.Line2).
 */
function vfdField(item: string | undefined, state: AppState): string {
  const { nad } = state;
  switch (item) {
    case 'MainSource':
      if (nad.mute) return 'MUTE';
      return nad.source ? state.sourceNames[String(nad.source)] ?? `Source ${nad.source}` : '';
    case 'Volume':
      return nad.volumeDb !== undefined ? `${nad.volumeDb} dB` : '';
    case 'ListeningMode':
      return nad.listeningMode ?? '';
    case 'AudioSourceFormat':
      return signalLine(nad.signal);
    case 'Zone2Source':
      return state.zone2.source
        ? state.sourceNames[String(state.zone2.source)] ?? `Source ${state.zone2.source}`
        : '';
    case 'Zone3Source':
      return 'Zone 3';
    case 'Zone4Source':
      return 'Zone 4';
    case 'Off':
    case undefined:
      return '';
    default:
      return item;
  }
}

/**
 * Skeuomorphic re-creation of the NAD T 777 front display (VFD style).
 * Mirrors the device exactly: each row follows the receiver's own
 * Main.VFD.Line1 / Line2 selection. Volume sits top-right as on the hardware.
 */
function NadDisplay({ state }: { state: AppState }) {
  const { nad, nowPlaying } = state;
  const off = nad.power === 'Off';
  const dim = /on/i.test(nad.dimmer ?? '');
  const vfd = nad.vfd ?? {};
  const line1 = vfdField(vfd.line1, state);
  const line2 = vfdField(vfd.line2, state);
  // Now-playing line from the streaming module (title · artist), shown like the
  // NAD's own display does — but ONLY while BluOS is the active source. On other
  // inputs BluOS reports a placeholder ("External Source"), which the receiver's
  // own VFD never shows, so we suppress it to stay faithful.
  const onBluos = state.bluosSourceIndex !== undefined && nad.source === state.bluosSourceIndex;
  const np = onBluos && nowPlaying.reachable
    ? [nowPlaying.title, nowPlaying.artist].filter(Boolean).join(' · ')
    : '';
  // NBSP keeps row height stable when a line resolves to empty (e.g. "Off").
  const nb = ' ';

  return (
    <div className={`vfd ${off ? 'vfd-off' : ''} ${dim ? 'vfd-dim' : ''}`}>
      {off ? (
        <div className="vfd-row vfd-standby">STANDBY</div>
      ) : (
        <>
          <div className="vfd-row vfd-top">
            <span className="vfd-src">{line1 || nb}</span>
            <span className="vfd-vol">{nad.volumeDb ?? '—'} dB</span>
          </div>
          {np && <div className="vfd-row vfd-mid">{np}</div>}
          <div className="vfd-row vfd-bot">
            <span className="vfd-sig">{line2 || nb}</span>
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
        <h2>{t('main.power')}</h2>
        <div className="row">
          <button className={`pill ${on ? 'active' : ''}`} onClick={() => api.power(true)}>{t('common.on')}</button>
          <button className={`pill ${!on ? 'active' : ''}`} onClick={() => api.power(false)}>{t('common.off')}</button>
          <button className={`pill ${nad.mute ? 'active warn' : ''}`} onClick={() => api.mute(!nad.mute)}>
            {nad.mute ? t('common.muted') : t('common.mute')}
          </button>
        </div>
        {state.bluosSourceIndex && state.nad.source !== state.bluosSourceIndex && (
          <button className="big-action" style={{ marginTop: 12 }} onClick={() => api.bluosActivate()}>
            {t('main.playOnNad')}
          </button>
        )}
      </section>

      <GuardedVolume
        label={t('main.volume')}
        current={nad.volumeDb}
        cap={safety.maxVolumeDb}
        maxStep={safety.maxStepDb}
        warnDb={safety.warnVolumeDb}
        defaultDb={safety.defaultVolumeDb}
        overCap={safety.overCapAlert}
        stepFn={api.volumeStep}
      />

      <section className="card">
        <h2>{t('main.source')}</h2>
        <SourceGrid current={nad.source} names={state.sourceNames} onSelect={api.source} />
      </section>

      <section className="card">
        <h2>{t('main.listeningMode')}</h2>
        <div className="row wrap">
          {LISTENING_MODES.map((m) => (
            <button key={m} className={`pill ${nad.listeningMode === m ? 'active' : ''}`} onClick={() => api.listeningMode(m)}>{m}</button>
          ))}
        </div>
        {nad.listeningMode && <p className="muted">{t('common.current')}: {nad.listeningMode}</p>}
      </section>

      <Gate state={state} cap="signal">
      <section className="card">
        <h2>{t('main.signal')}</h2>
        <ul className="kv">
          <li><span>{t('sig.codec')}</span><b>{nad.signal?.codec ?? '—'}</b></li>
          <li><span>{t('sig.channels')}</span><b>{nad.signal?.channels ?? '—'}</b></li>
          <li><span>{t('sig.rate')}</span><b>{nad.signal?.rateKhz ? `${nad.signal.rateKhz} kHz` : '—'}</b></li>
          <li><span>{t('sig.lock')}</span><b>{nad.signal?.lock ?? '—'}</b></li>
          <li><span>{t('sig.video')}</span><b>{nad.signal?.videoResolution || '—'}</b></li>
          <li><span>{t('sig.delay')}</span><b>{nad.signal?.delay ?? '—'}</b></li>
          <li><span>{t('sig.bluosQuality')}</span><b>{state.nowPlaying.quality ?? '—'}{state.nowPlaying.service ? ` · ${state.nowPlaying.service}` : ''}</b></li>
        </ul>
      </section>
      </Gate>
    </div>
    </>
  );
}

function BluosModuleCard({ reachable }: { reachable: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reboot() {
    if (!confirm(t('bluos.rebootConfirm'))) return;
    setBusy(true); setMsg(null);
    const r = (await api.bluosReboot()) as { ok: boolean; detail?: string; reason?: string };
    setBusy(false);
    setMsg(r.detail ?? r.reason ?? (r.ok ? 'Reboot requested.' : 'Failed.'));
  }

  return (
    <section className="card">
      <h2>{t('bluos.module')}</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`badge ${reachable ? 'ok' : 'bad'}`}>{reachable ? t('bluos.ok') : t('bluos.down')}</span>
        <button className="pill" onClick={reboot} disabled={busy}>{t('bluos.tryReboot')}</button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{t('bluos.noRebootApi')}</p>
      <ul className="muted" style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>
        <li>{t('bluos.rebootApp')}</li>
        <li>{t('bluos.rebootPower')}</li>
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
  const srcName = state.nad.source ? state.sourceNames[String(state.nad.source)] ?? String(state.nad.source) : '—';

  return (
    <div className="grid">
      <section className="card">
        <h2>{t('play.title')}</h2>
        <button className="big-action" onClick={() => api.bluosActivate()} disabled={!bluosIdx}>
          {t('play.playNow')}
        </button>
        <div className="row" style={{ margin: '10px 0' }}>
          <span className={`badge ${onBluos ? 'ok' : 'dim'}`}>
            {onBluos ? t('play.onBluos') : t('play.sourceIs', { name: srcName })}
          </span>
          {playing && <span className="badge ok">{t('play.streaming')}</span>}
        </div>
        <p className="muted">{t('play.explain')}</p>
        <ToggleSettingRaw label={t('play.autoSwitch')} on={state.autoSwitchOnPlay} onSet={(v) => api.autoswitch(v)} />
        <p className="muted" style={{ fontSize: 12 }}>{t('play.autoNote')}</p>
        {!bluosIdx && <p className="reject">{t('play.noBluos')}</p>}
      </section>

      <BluosModuleCard reachable={!!np.reachable} />

      <section className="card nowplaying">
        <h2>{t('play.nowPlaying')} <span className="muted">({t('play.viaStreaming')})</span></h2>
        {!np.reachable ? (
          <p className="muted">{t('play.unreachable')}</p>
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
        <h2>{t('play.presets')}</h2>
        {presets.length === 0 ? (
          <p className="muted">{t('play.noPresets')}</p>
        ) : (
          <div className="row wrap">
            {presets.map((p) => (
              <button key={p.id} className="pill" onClick={() => api.bluosPreset(p.id)}>{p.id}. {p.name}</button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t('play.queue')} <span className="muted">{t('play.queueSub')}</span></h2>
        {queue.length === 0 ? (
          <p className="muted">{t('play.queueEmpty')}</p>
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
  const [crumbs, setCrumbs] = useState<{ key?: string; label: string }[]>([{ label: t('lib.root') }]);
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
        <h2>{t('lib.browse')} <span className="muted">{t('lib.browseSub')}</span></h2>
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="crumb-sep">›</span>}
              <button className="crumb" onClick={() => goto(i)}>{c.label}</button>
            </span>
          ))}
        </div>
        {loading ? (
          <p className="muted">{t('common.loading')}</p>
        ) : res.items.length === 0 ? (
          <p className="muted">{t('lib.empty')}</p>
        ) : (
          <div className="browse-list">
            {res.items.map((it, i) => (
              <button key={i} className={`browse-item ${it.playURL ? 'audio' : 'link'}`} onClick={() => open(it)}>
                <span className="bi-text">{it.text}</span>
                <span className="bi-act">{it.playURL ? t('lib.play') : it.browseKey ? '›' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="usage-head">
          <h2>{t('lib.tracklist')} <span className="muted">{t('lib.tracklistSub')}</span></h2>
          <span className="seg">
            <a className="pill" href="/api/tracks/export.csv" download>{t('lib.exportCsv')}</a>
            <button className="pill" onClick={() => { if (confirm(t('lib.clearConfirm'))) void api.tracksClear().then(reloadTracks); }}>{t('common.clear')}</button>
          </span>
        </div>
        <p className="muted">{t('lib.tracklistNote', { n: tracks.length })}</p>
        {tracks.length === 0 ? (
          <p className="muted">{t('lib.noTracks')}</p>
        ) : (
          <div className="table-wrap">
            <table className="usage">
              <thead><tr><th>{t('col.title')}</th><th>{t('col.artist')}</th><th>{t('col.album')}</th><th>{t('col.service')}</th><th>{t('col.plays')}</th></tr></thead>
              <tbody>
                {tracks.map((tr, i) => (
                  <tr key={i}>
                    <td><b>{tr.title}</b></td>
                    <td>{tr.artist ?? '—'}</td>
                    <td className="muted">{tr.album ?? '—'}</td>
                    <td>{tr.service ?? '—'}</td>
                    <td className="num">{tr.plays}</td>
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
  const tn = state.tuner;
  const tunerSrc = state.tunerSourceIndex;
  return (
    <div className="grid">
      <section className="card">
        <h2>{t('tuner.title')}</h2>
        {!tn.active && (
          <div className="hint">
            {t('tuner.hint')}
            {tunerSrc && (
              <button className="pill" onClick={() => api.source(tunerSrc)} style={{ marginLeft: 8 }}>
                {t('tuner.switchTo', { name: state.sourceNames[String(tunerSrc)] ?? 'Tuner' })}
              </button>
            )}
          </div>
        )}
        <div className="tuner-readout">
          <span className="big">{tn.fmFrequency ?? '—'}</span>
          <span className="unit">{tn.band ?? ''}</span>
        </div>
        <div className="row">
          <button className={`pill ${tn.band === 'FM' ? 'active' : ''}`} disabled={!tn.active} onClick={() => api.tunerBand('FM')}>FM</button>
          <button className={`pill ${tn.band === 'AM' ? 'active' : ''}`} disabled={!tn.active} onClick={() => api.tunerBand('AM')}>AM</button>
          <button className="pill" disabled={!tn.active} onClick={() => api.tunerTune('down')}>{t('tuner.tuneDown')}</button>
          <button className="pill" disabled={!tn.active} onClick={() => api.tunerTune('up')}>{t('tuner.tuneUp')}</button>
          <button className={`pill ${tn.mute ? 'active warn' : ''}`} disabled={!tn.active} onClick={() => api.tunerMute(!tn.mute)}>
            {tn.mute ? t('common.muted') : t('common.mute')}
          </button>
        </div>
        <h2 style={{ marginTop: 18 }}>{t('tuner.presets')}</h2>
        <div className="row wrap">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button key={n} className={`pill ${tn.fmPreset === String(n) ? 'active' : ''}`} disabled={!tn.active} onClick={() => api.tunerPreset(n)}>P{n}</button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>{t('tuner.note')}</p>
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
        <h2>{t('z2.power')}</h2>
        <div className="row">
          <button className={`pill ${on ? 'active' : ''}`} onClick={() => api.zone2Power(true)}>{t('common.on')}</button>
          <button className={`pill ${!on ? 'active' : ''}`} onClick={() => api.zone2Power(false)}>{t('common.off')}</button>
          <button className={`pill ${z.mute ? 'active warn' : ''}`} onClick={() => api.zone2Mute(!z.mute)}>
            {z.mute ? t('common.muted') : t('common.mute')}
          </button>
        </div>
      </section>

      <GuardedVolume
        label={t('z2.volume', { n: zs.maxVolumeDb })}
        current={z.volumeDb}
        cap={zs.maxVolumeDb}
        maxStep={zs.maxStepDb}
        warnDb={zs.warnVolumeDb}
        defaultDb={zs.defaultVolumeDb}
        overCap={z.overCapAlert}
        stepFn={api.zone2VolumeStep}
      />

      <section className="card">
        <h2>{t('z2.source')}</h2>
        <SourceGrid current={z.source} names={state.sourceNames} onSelect={api.zone2Source} />
      </section>

      <section className="card">
        <h2>{t('z2.outputMode')}</h2>
        <EnumSetting label={t('z2.volumeControl')} k="Zone2.VolumeControl" value={z.volumeControl} options={['Variable', 'Fixed']} />
        <ul className="kv" style={{ marginTop: 8 }}>
          <li><span>{t('z2.fixedLevel')}</span><b>{z.volumeFixed ?? '—'} dB</b></li>
        </ul>
        {z.volumeControl === 'Fixed' && (
          <p className="reject">{t('z2.fixedWarn', { v: z.volumeFixed ?? '—' })}</p>
        )}
      </section>
    </div>
  );
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
      <td className="num">{seg.open ? t('usage.now') : fmtClock(seg.endedAt)}</td>
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
          <h2>{t('usage.title')} <span className="muted">{t('usage.sub')}</span></h2>
          <button className="pill" onClick={() => { if (confirm(t('usage.clearConfirm'))) void usageClear().then(() => fetchUsage(300).then(setLog)); }}>{t('common.clear')}</button>
        </div>
        <p className="muted">{t('usage.summary', { n: log.segments.length, dur: fmtDur(totalSec) })}</p>
        {rows.length === 0 ? (
          <p className="muted">{t('usage.empty')}</p>
        ) : (
          <div className="table-wrap">
            <table className="usage">
              <thead>
                <tr>
                  <th>{t('col.source')}</th><th>{t('col.started')}</th><th>{t('col.ended')}</th><th>{t('col.duration')}</th>
                  <th>{t('col.avgDb')}</th><th>{t('col.minMax')}</th>
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

function HelpTab() {
  return (
    <div className="grid one">
      {manual().map((sec, i) => (
        <section className="card" key={i}>
          <h2>{sec.h}</h2>
          <ul className="help-list">
            {sec.items.map((it, j) => <li key={j}>{it}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ---- Generic setting controls (optimistic; bound to /api/setting) ---- */

const ADOPT_AFTER_MS = 1600;

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
  const [local, setLocal, editedAt] = useOptimistic(on);
  const [error, setError] = useState<string | null>(null);
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => { setError(null); }, [on]);

  const set = async (v: boolean) => {
    setError(null);
    setLocal(v);
    const r = await api.setting(k, v);
    if (!r.ok) {
      setLocal(onRef.current);
      editedAt.current = 0;
      setError(r.error ?? r.reason ?? 'błąd zapisu');
    }
  };
  return (
    <div className={`setting-row ${error ? 'err' : ''}`}>
      <span>{label}</span>
      <span className="seg">
        <button className={`pill ${local ? 'active' : ''}`} onClick={() => void set(true)}>{t('common.on')}</button>
        <button className={`pill ${local === false ? 'active' : ''}`} onClick={() => void set(false)}>{t('common.off')}</button>
        {error && <span className="setting-err" title={error} role="alert">⚠</span>}
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
        <button className={`pill ${local ? 'active' : ''}`} onClick={() => set(true)}>{t('common.on')}</button>
        <button className={`pill ${local === false ? 'active' : ''}`} onClick={() => set(false)}>{t('common.off')}</button>
      </span>
    </div>
  );
}

function IntSetting({
  label, k, value, unit, step = 1, min, max,
}: { label: string; k: string; value?: number; unit?: string; step?: number; min?: number; max?: number }) {
  const [local, setLocal, editedAt] = useOptimistic(value);
  const sendTimer = useRef<ReturnType<typeof setTimeout>>();
  const [error, setError] = useState<string | null>(null);
  // Latest device-confirmed value, for reverting an optimistic update on failure.
  const valueRef = useRef(value);
  valueRef.current = value;
  // A fresh confirmed value arriving clears any prior error (e.g. a retry worked).
  useEffect(() => { setError(null); }, [value]);

  function bump(delta: number) {
    const base = local ?? value ?? 0;
    let next = base + delta;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    if (next === base) return;
    setError(null);
    setLocal(next);
    editedAt.current = Date.now();
    clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(async () => {
      const r = await api.setting(k, next);
      if (!r.ok) {
        // Write rejected/failed — drop the optimistic value back to what the
        // device last confirmed and surface the reason, so a stuck number
        // can't read as "applied" when it wasn't.
        setLocal(valueRef.current);
        editedAt.current = 0;
        setError(r.error ?? r.reason ?? 'błąd zapisu');
      }
    }, 160);
  }

  return (
    <div className={`setting-row ${error ? 'err' : ''}`}>
      <span>{label}</span>
      <span className="seg">
        <button className="step sm" onClick={() => bump(-step)}>−</button>
        <b className="setting-val">{local ?? '—'}{unit ? ` ${unit}` : ''}</b>
        {error && <span className="setting-err" title={error} role="alert">⚠</span>}
        <button className="step sm" onClick={() => bump(+step)}>+</button>
      </span>
    </div>
  );
}

function EnumSetting({ label, k, value, options }: { label: string; k: string; value?: string; options: string[] }) {
  const [local, setLocal, editedAt] = useOptimistic(value);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => { setError(null); }, [value]);

  const set = async (o: string) => {
    setError(null);
    setLocal(o);
    const r = await api.setting(k, o);
    if (!r.ok) {
      setLocal(valueRef.current);
      editedAt.current = 0;
      setError(r.error ?? r.reason ?? 'błąd zapisu');
    }
  };
  return (
    <div className={`setting-row ${error ? 'err' : ''}`}>
      <span>{label}</span>
      <span className="seg">
        {options.map((o) => (
          <button key={o} className={`pill ${local === o ? 'active' : ''}`} onClick={() => void set(o)}>{o}</button>
        ))}
        {error && <span className="setting-err" title={error} role="alert">⚠</span>}
      </span>
    </div>
  );
}

function AudioTab({ state }: { state: AppState }) {
  const tone = state.nad.tone ?? {};
  const s = state.nad.setup ?? {};
  const sur = state.nad.surround ?? {};
  return (
    <div className="grid">
      <Gate state={state} cap="tone">
      <section className="card">
        <h2>{t('audio.tone')}</h2>
        <IntSetting label={t('audio.bass')} k="Main.Bass" value={tone.bass} unit="dB" min={-10} max={10} />
        <IntSetting label={t('audio.treble')} k="Main.Treble" value={tone.treble} unit="dB" min={-10} max={10} />
        <ToggleSetting label={t('audio.toneDefeat')} k="Main.ToneDefeat" on={tone.toneDefeat} />
      </section>
      </Gate>

      <Gate state={state} cap="bassMgmt">
      <section className="card">
        <h2>{t('audio.bassMgmt')}</h2>
        <ToggleSetting label={t('audio.subwoofer')} k="Main.Speaker.Sub" on={s.subOn} />
        <ToggleSetting label={t('audio.enhancedBass')} k="Main.EnhancedBass" on={s.enhancedBass} />
        <IntSetting label={t('audio.centerDialog')} k="Main.CenterDialog" value={s.centerDialog} min={0} max={6} />
      </section>
      </Gate>

      <Gate state={state} cap="bassMgmt">
      <section className="card">
        <h2>{t('audio.speakerLevels')}</h2>
        {/* Per-speaker calibration, -12..+12 dB. Each row shows only if the
            connected layout has that channel (the device answered its key). */}
        {s.levelFrontLeft !== undefined && (
          <IntSetting label={t('audio.levelFrontLeft')} k="Main.Level.Left" value={s.levelFrontLeft} unit="dB" min={-12} max={12} />
        )}
        {s.levelFrontRight !== undefined && (
          <IntSetting label={t('audio.levelFrontRight')} k="Main.Level.Right" value={s.levelFrontRight} unit="dB" min={-12} max={12} />
        )}
        {s.levelCenter !== undefined && (
          <IntSetting label={t('audio.centerLevel')} k="Main.Level.Center" value={s.levelCenter} unit="dB" min={-12} max={12} />
        )}
        {s.levelSurroundLeft !== undefined && (
          <IntSetting label={t('audio.levelSurroundLeft')} k="Main.Level.SurroundLeft" value={s.levelSurroundLeft} unit="dB" min={-12} max={12} />
        )}
        {s.levelSurroundRight !== undefined && (
          <IntSetting label={t('audio.levelSurroundRight')} k="Main.Level.SurroundRight" value={s.levelSurroundRight} unit="dB" min={-12} max={12} />
        )}
        {s.levelBackLeft !== undefined && (
          <IntSetting label={t('audio.levelBackLeft')} k="Main.Level.BackLeft" value={s.levelBackLeft} unit="dB" min={-12} max={12} />
        )}
        {s.levelBackRight !== undefined && (
          <IntSetting label={t('audio.levelBackRight')} k="Main.Level.BackRight" value={s.levelBackRight} unit="dB" min={-12} max={12} />
        )}
        {s.levelSub !== undefined && (
          <IntSetting label={t('audio.subLevel')} k="Main.Level.Sub" value={s.levelSub} unit="dB" min={-12} max={12} />
        )}
      </section>
      </Gate>

      <Gate state={state} cap="speakerConfig">
      <section className="card">
        <h2>{t('audio.speakerConfig')}</h2>
        <EnumSetting label={t('audio.front', { hz: s.frontFreq ?? '—' })} k="Main.Speaker.Front.Config" value={s.frontConfig} options={['Large', 'Small']} />
        <EnumSetting label={t('audio.center', { hz: s.centerFreq ?? '—' })} k="Main.Speaker.Center.Config" value={s.centerConfig} options={['Large', 'Small']} />
        <EnumSetting label={t('audio.surround', { hz: s.surroundFreq ?? '—' })} k="Main.Speaker.Surround.Config" value={s.surroundConfig} options={['Large', 'Small']} />
        <p className="muted">{t('audio.xoverNote')}</p>
      </section>
      </Gate>

      <Gate state={state} cap="dolby">
      <section className="card">
        <h2>{t('audio.surroundParams')}</h2>
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
        <p className="muted">{t('audio.surroundNote')}</p>
      </section>
      </Gate>
    </div>
  );
}

/** Live compatibility matrix: what this connected NAD actually supports. */
function CapabilityPanel({ state }: { state: AppState }) {
  const ready = state.capabilitiesReady;
  const n = (s: CapabilityStatus) => CAP_LABELS.filter((c) => capOf(state, c.id) === s).length;
  return (
    <section className="card">
      <div className="usage-head">
        <h2>{t('cap.title')} <span className="muted">{state.nad.model ?? 'NAD'}{state.nad.version ? ` ${state.nad.version}` : ''}</span></h2>
        <span className={`badge ${ready ? 'ok' : 'dim'}`}>{ready ? t('cap.ready') : t('cap.probing')}</span>
      </div>
      <p className="muted">{t('cap.summary', { y: n('supported'), q: n('unknown'), x: n('unsupported') })}</p>
      <ul className="kv cap-list">
        {CAP_LABELS.map((c) => (
          <li key={c.id}><span>{c.label}</span><CapBadge status={capOf(state, c.id)} /></li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: 12 }}>{t('cap.note')}</p>
    </section>
  );
}

function SystemTab({ state }: { state: AppState }) {
  const { nad, safety } = state;
  const dimOn = /on/i.test(nad.dimmer ?? '');
  const SLEEPS = [0, 15, 30, 45, 60, 90];
  return (
    <div className="grid">
      <section className="card">
        <h2>{t('sys.dimmer')}</h2>
        <div className="row">
          <button className={`pill ${dimOn ? 'active' : ''}`} onClick={() => api.dimmer(true)}>{t('sys.dimOn')}</button>
          <button className={`pill ${!dimOn ? 'active' : ''}`} onClick={() => api.dimmer(false)}>{t('sys.dimOff')}</button>
        </div>
        <p className="muted">{t('common.current')}: {nad.dimmer ?? '—'}</p>
      </section>

      <section className="card">
        <h2>{t('sys.sleep')}</h2>
        <div className="row wrap">
          {SLEEPS.map((m) => (
            <button key={m} className={`pill ${nad.sleepMinutes === m ? 'active' : ''}`} onClick={() => api.sleep(m)}>
              {m === 0 ? t('common.off') : `${m} ${t('common.min')}`}
            </button>
          ))}
        </div>
        <p className="muted">{t('common.current')}: {nad.sleepMinutes === 0 || nad.sleepMinutes === undefined ? t('common.off') : `${nad.sleepMinutes} ${t('common.min')}`}</p>
      </section>

      <section className="card">
        <h2>{t('sys.standbyDisplay')}</h2>
        <ToggleSetting label={t('sys.autoStandby')} k="Main.AutoStandby" on={nad.system?.autoStandby} />
        <ToggleSetting label={t('sys.osdTemp')} k="Main.OSD.TempDisplay" on={nad.system?.osdTempDisplay} />
      </section>

      <Gate state={state} cap="cec">
      <section className="card">
        <h2>{t('sys.cec')}</h2>
        {/* ARC is auto-negotiated on V3: 'On' doesn't persist — offer only Auto/Off. */}
        <EnumSetting label="ARC" k="Main.CEC.ARC" value={nad.system?.cecArc} options={['Auto', 'Off']} />
        <ToggleSetting label={t('sys.cecAudio')} k="Main.CEC.Audio" on={nad.system?.cecAudio} />
        <ToggleSetting label={t('sys.cecSwitch')} k="Main.CEC.Switch" on={nad.system?.cecSwitch} />
        <ToggleSetting label={t('sys.cecPower')} k="Main.CEC.Power" on={nad.system?.cecPower} />
      </section>
      </Gate>

      <CapabilityPanel state={state} />

      <AboutCard />

      <section className="card">
        <h2>{t('sys.device')}</h2>
        <ul className="kv">
          <li><span>{t('sys.model')}</span><b>{nad.model ?? '—'}</b></li>
          <li><span>{t('sys.firmware')}</span><b>{nad.version ?? '—'}</b></li>
          <li><span>{t('sys.nadLink')}</span><b>{nad.reachable ? t('sys.connected') : t('badge.down')}</b></li>
          <li><span>{t('sys.triggers')}</span><b>{nad.system?.trigger1Out ?? '—'} / {nad.system?.trigger2Out ?? '—'}</b></li>
          <li><span>{t('sys.videoRes')}</span><b>{nad.signal?.videoResolution || '—'}</b></li>
          <li><span>{t('sig.delay')}</span><b>{nad.signal?.delay ?? '—'}</b></li>
          {DIRAC_ENABLED && (
            <li><span>Dirac (5006)</span><b>{state.diracAvailable ? t('cap.yes') : capOf(state, 'dirac') === 'unknown' ? '…' : t('sys.diracAbsent')}</b></li>
          )}
        </ul>
      </section>

      <section className="card">
        <h2>{t('sys.volumeSafety')}</h2>
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
        <p className="muted">{t('sys.safetyNote')}</p>
      </section>
    </div>
  );
}
