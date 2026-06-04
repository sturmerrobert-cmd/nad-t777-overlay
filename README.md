# Receiver HQ — local control & monitoring app for A/V receivers

Small, **local-only** control app for compatible A/V receivers (NAD V2.x control
protocol): power, guarded volume, source, mute, listening mode, and a streaming
now-playing card. No cloud, no third-party auth. pnpm monorepo: `apps/api`
(Fastify 5 + WebSocket) and `apps/web` (React + Vite).

> **Trademarks / non-affiliation.** Receiver HQ is an independent, unofficial
> product. Not affiliated with, sponsored, or endorsed by NAD or Lenbrook
> Industries. "NAD" is a trademark of Lenbrook Industries; "BluOS"/"Bluesound"
> of Lenbrook; "Dolby"/"DTS"/"Dirac" of their respective owners — used here
> **only descriptively** to state hardware compatibility. See `DISCLAIMER.txt`,
> `EULA.txt`, `PRIVACY.md`, `THIRD-PARTY-NOTICES.txt`.

> This is a standalone project rooted at `~/nad`. It is **not** part of any other
> repo or monorepo.

> **Security model.** The API controls an amplifier, so by default it binds
> **loopback only** (`127.0.0.1`) and serves a **Host-header allowlist** that blocks
> LAN access and DNS-rebinding from any website. To reach the UI from another device
> on your LAN, set `ALLOW_LAN=1` (an explicit opt-in; a token is recommended then).

## Phase 0 discovery result (device `192.168.1.2`)

| Interface | Live | Notes |
|---|---|---|
| NAD control (TCP:23) | ✅ | `T777`, firmware `v2.24`, V2.x ASCII protocol |
| BluOS (HTTP:11000)   | ✅ | now-playing, status, presets, transport |
| Dirac (HTTP:5006)    | ❌ | `ECONNREFUSED` — **absent on this unit**; Dirac panel disabled |

There is **no hardware telemetry** on the receiver (no temperature, mains draw,
per-channel power, fan speed, or protection status) — none of that is surfaced.
Real power draw could only ever come from an external metering smart plug
(optional, not implemented).

## Active features

The UI is organized into a tabbed menu:

- **Główne (Main):** a VFD-style re-creation of the NAD T 777 front display
  (source, volume, now-playing title, listening mode + live signal line), then
  power, mute, **guarded volume** (see below), source (1–12 with the device's own
  configured names), listening mode, and a **Signal / quality** card.
  The signal info comes from the receiver's own decode (`Main.Audio.CODEC`,
  `Main.Audio.Channels`, `Main.Audio.Rate`, `Main.Audio.Lock`) plus BluOS
  `quality`/`service`.
- **Odtwarzanie (Now Playing):** BluOS now-playing card, transport, presets, plus
  **"Play through the NAD"**: a manual "Play on NAD now" button and an opt-in
  **auto-switch** — when BluOS playback starts (e.g. you hit play in Spotify), the
  receiver is powered on and its source is switched to BluOS so you actually hear
  it. This **never changes volume** (G2); it only sets power + source. Default off
  (`AUTOSWITCH_ON_PLAY`, runtime-toggleable in the UI).
- **Tuner:** band (FM/AM), tune ◀/▶, FM presets, mute — per the NAD V2.x reference.
  These respond only when the tuner is the active source; the tab shows a hint and
  a one-tap "switch to Tuner" when it isn't.
- **Dźwięk (Audio):** tone (bass/treble + tone defeat), bass management (sub on/off,
  enhanced bass, center/sub level, center dialog), speaker config (Large/Small +
  crossover shown), and surround params (Dolby/DTS — toggles settable, rest shown).
- **Strefa 2 (Zone 2):** power, source, mute, **guarded Zone 2 volume** (same cap/step
  guard as Main), plus output mode (Variable/Fixed; fixed level shown with a warning
  that it is not bounded by the cap).
- **Biblioteka (Library):** a BluOS browser (radio, playlists, services, and your
  local NAS/USB library when present) with breadcrumb navigation and one-tap play —
  the same control the BluOS app has. Plus **"My track list"**: distinct tracks
  captured from now-playing (**titles/artists only — never audio**), exportable to
  CSV. A legal "shopping list" to buy the files (Bandcamp/Qobuz/7digital) or add to a
  NAS for local playback. The "Odtwarzanie" tab also shows the current play queue.
- **Log użycia (Usage):** what played, for how long, and how loud — derived purely
  from polling. A new segment starts when the source changes or power toggles;
  each segment records start/end, duration, and volume min/avg/max/last. History is
  persisted to a JSONL file (`USAGE_LOG_FILE`, default `apps/api/data/usage-log.jsonl`,
  gitignored) so it survives restarts. Clear button included.
- **System:** display dimmer, sleep timer, auto-standby, OSD temp display, HDMI-CEC
  (ARC/audio/switch/power), device info (model/firmware/triggers/video resolution/
  A/V delay), and the live volume-safety settings.

All non-volume settings go through a single allowlisted endpoint
(`POST /api/setting`, `POST /api/setting/step`) backed by a catalog in
`apps/api/src/settings.ts`. That path **hard-refuses any key containing "Volume"**,
so it can never be used to bypass the volume guard. The catalog is browsable at
`GET /api/settings/catalog`.

All command surfaces were grounded against the live device in discovery (source
names, dimmer, sleep, Zone 2 all confirmed). Tuner detail keys were not verified
because the tuner wasn't the active source — the UI labels them accordingly.

Disabled / not built: Dirac panel (no port 5006), any hardware telemetry.

## Volume safety (most important part)

Two guarantees, enforced **server-side** and not bypassable by the UI:

- **G1 — never above the cap.** Every absolute set is clamped to `MAX_VOLUME_DB`;
  relative steps are computed against current volume and clamped. The UI slider's
  max is the cap, so it cannot even represent a louder value.
- **G2 — never raises volume on its own.** Nothing sets volume on startup,
  reconnect, source change, or playback start. The app only reads and displays
  the current volume.

Rules in force:

- `MAX_VOLUME_DB` is **required** — the backend refuses to start without it (no
  silent default).
- `MAX_STEP_DB` (default 5): any single command moving volume more than this is
  **rejected** (a UI bug can't jump volume in one shot). Volume commands are
  rate-limited. The slider reaches a far target by ramping in ≤ `MAX_STEP_DB`
  steps, each a separate guarded command.
- `WARN_VOLUME_DB`: above this (still below the cap) the UI requires an explicit
  confirm tap before sending.
- `DEFAULT_VOLUME_DB`: **UI-only** initial slider position; never auto-sent.
- Startup/reconnect: if observed volume is over the cap, the UI raises an alert.
  It is auto-pulled-down only if `CLAMP_ON_OBSERVED=true` (default false).
- `VOLUME_WATCHDOG` (default false): if true, polls and clamps any over-cap
  volume from **any** source — **this overrides the physical remote/knob**, which
  is why it is off by default.

Unit tests for the clamp/step/relative logic: `apps/api/src/volume/guard.test.ts`.

## Configuration (`.env` at repo root)

```
DEVICE_IP=192.168.1.2
MAX_VOLUME_DB=-30        # required; hard cap (louder = higher dB)
MAX_STEP_DB=5
WARN_VOLUME_DB=-40
DEFAULT_VOLUME_DB=-50    # UI slider start only; never auto-sent
CLAMP_ON_OBSERVED=false
VOLUME_WATCHDOG=false
HTTP_PORT=8787
```

See `.env.example`. The app reads `.env` via `--env-file`.

## Run

```bash
pnpm install

# Phase 0 discovery probe (read-only)
DEVICE_IP=192.168.1.2 pnpm probe

# Backend (reads .env at repo root)
pnpm --filter @nad/api dev      # http://localhost:8787

# Frontend (proxies /api and /ws to the backend)
pnpm --filter @nad/web dev      # http://localhost:5173
```

Open http://localhost:5173.

## Tests / checks

```bash
pnpm --filter @nad/api test         # volume guard unit tests
pnpm --filter @nad/api typecheck
pnpm --filter @nad/web typecheck
```

## Layout

```
apps/api
  scripts/probe.ts        Phase 0 discovery probe
  src/config.ts           env validation (refuses start without MAX_VOLUME_DB)
  src/volume/guard.ts     pure clamp/step/relative logic  ← safety-critical
  src/volume/guard.test.ts
  src/volume/service.ts   guarded volume service (only path that sets volume)
  src/nad/client.ts       NAD TCP:23 client
  src/bluos/client.ts     BluOS HTTP:11000 client
  src/state.ts            polling + state + over-cap alert/watchdog
  src/server.ts           Fastify routes + WebSocket
  src/index.ts            entry
apps/web                  React + Vite UI
```

## WSL2 networking note

The receiver is reached as an outbound connection from WSL2 to a LAN IP — works
through the default NAT. Use the explicit IP, not an mDNS/`.local` name. If it
times out, sanity-check with `curl http://<ip>:11000/SyncStatus` from Windows
PowerShell and consider WSL2 mirrored networking (`networkingMode=mirrored` in
`%USERPROFILE%\.wslconfig`, then `wsl --shutdown`).
