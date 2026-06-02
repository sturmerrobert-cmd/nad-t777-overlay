# nad — NAD T 777 control & monitoring overlay

Small, **local-only** overlay for a NAD T 777 receiver: power, guarded volume,
source, mute, listening mode, and a BluOS now-playing card. No cloud, no
third-party auth. pnpm monorepo: `apps/api` (Fastify 5 + WebSocket) and
`apps/web` (React + Vite).

> This is a standalone project rooted at `~/nad`. It is **not** part of any other
> repo or monorepo.

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

- **Power** on/off, **mute**
- **Guarded volume** (see below) — step buttons + slider, capped in UI and server
- **Source** 1–12 with editable names
- **Listening mode**
- **Now-playing** card from BluOS `/SyncStatus` + `/Status`
- **BluOS** presets and transport (play/pause/skip/back)

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
