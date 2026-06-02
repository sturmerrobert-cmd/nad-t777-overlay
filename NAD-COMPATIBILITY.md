# NAD compatibility — protocol V2.x (ASCII, RS232 / TCP:23) + BluOS

Generated from the official NAD command lists (`NAD_TXX7_Protocol_Docs.zip`,
`NAD_TXX5_Protocol_Docs.zip`, `NAD_M15HD_Protocol_Docs.zip` from
nadelectronics.com/software) and cross-checked against the keys this app actually
uses (`apps/api/src/nad/client.ts`).

## Transport (identical for every model below)

- Second-generation **NAD protocol V2.x**, fully ASCII.
- Commands `Key.Sub?` (query) / `=value` (set) / `+` / `-` (step), each wrapped in `<CR>`.
- RS-232: **115200 bps, 8N1, no flow control**, DB9, **straight-through** cable (pins 2/3/5).
- Ethernet: **raw TCP socket on port 23** — commands 100% identical to RS-232.
- BluOS and Dirac are **NOT part of this protocol**:
  - BluOS = separate HTTP API on **:11000** (MDC BluOS module only).
  - Dirac Live = control on **:5006** (Dirac-equipped models only).

## ⚠️ Two generations share these model numbers

The published PDFs are the **first generation** (spec v2.03, dated **27 Apr 2012**).
The app's real target — **T 777 V3** — is the **later MDC generation** (2015+), whose
firmware *added* keys the 2012 docs never had. The site never published the V3 list.

| | 1st gen (the PDFs) | Later "V2 / V3 / MDC" gen (app target) |
|---|---|---|
| Examples | T755, T765, T775, T785, T175, T187, M15HD, original T777/T787 | T 777 V2/V3, T 758 V3/V3i, T 778, M17/M17 V2 |
| `Main.Audio.*` live signal | ✗ | ✓ |
| `SourceN.Name` query | ✗ | ✓ |
| Auto-standby (power-off timer) | ✗ (no equivalent) | `Main.AutoStandby` |
| HDMI ARC | `Main.CEC.Arc` (mixed case) | `Main.CEC.ARC` (upper case) |
| Tuner preset key | `Tuner.Preset` | `Tuner.FM.Preset` |
| BluOS module | ✗ | ✓ (MDC) |
| Dirac Live (:5006) | ✗ | ✓ (model-dependent) |

> **Two true name-only differences** among keys the app uses, both handled by an
> alias resolver (`apps/api/src/nad/aliases.ts`) so they work on either generation:
> - tuner preset: `Tuner.FM.Preset` (V3) ⇄ `Tuner.Preset` (first-gen, Range 1-40)
> - HDMI ARC: `Main.CEC.ARC` (V3) ⇄ `Main.CEC.Arc` (first-gen — case only, and the
>   key map is case-sensitive, so it's a real mismatch).
>
> **NOT a rename:** first-gen `Main.ControlStandby` ("allow Ethernet control while
> in standby") is a *different* feature from V3 `Main.AutoStandby` (auto power-off).
> First-gen has no auto-standby at all — correctly reported unsupported, not aliased.

## App-feature matrix

`Y` = key present in that model's command list · `A` = works via the alias resolver
(different spelling) · `✗` = genuinely absent. Columns are every model documented in
the three ZIPs. **None is the T 777 V3** the app targets — they are its first-gen
namesakes/siblings (M15HD and T175/T187 are pre-pros, no power amp).

| App feature | key probed | T777 | T787 | T785 | T187 | T775 | T765 | T755 | T175 | M15HD |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Power / Volume / Mute / Source | `Main.Power` … | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Listening mode | `Main.ListeningMode` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Dimmer / Sleep | `Main.Dimmer` `Main.Sleep` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Tone (bass/treble) | `Main.Bass` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Bass mgmt / levels | `Main.Speaker.Sub` | Y | Y | Y | Y | Y* | Y | Y* | Y | Y |
| Speaker config | `Main.Speaker.Front.Config` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Dolby / DTS params | `Main.Dolby.*` `Main.DTS.*` | Y | Y | Y | Y | part | Y | Y | Y | Y |
| Triggers / OSD temp | `Main.Trigger1.Out` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Video resolution | `Main.Video.Resolution` | Y | Y | Y | Y | Y | Y | **✗** | Y | Y |
| Zone 2 (+fixed/var) | `Zone2.Power` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Zone 3 / Zone 4 | `Zone3.Power` | Y | Y | Y | Y | Y | part | **✗** | Y | Y |
| Tuner (FM/AM/DAB/XM) | `Tuner.Band` | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| FM preset | `Tuner.FM.Preset` ⇄ `Tuner.Preset` | A | A | A | A | A | A | A | A | A |
| HDMI ARC | `Main.CEC.ARC` ⇄ `Main.CEC.Arc` | A | A | A | A | A | A | **✗** | A | A |
| **Live signal readout** | `Main.Audio.CODEC` | **✗** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Source names** | `Source1.Name` | **✗** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Auto standby (power-off)** | `Main.AutoStandby` | **✗** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BluOS / Dirac | (out of band) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

`*` = present but a slightly reduced subset. "part" = some sub-keys only.
The bold `✗` rows are **V3-firmware additions** — present on the app's actual
T 777 V3, absent from every published doc model, and correctly greyed out by
discovery. ARC and FM-preset are NOT additions: they exist first-gen under a
different spelling and the alias resolver makes them work on both generations.
(T755 has no HDMI/CEC at all, so ARC is genuinely absent there.)

Facts across all 9 doc models: **10 source slots** (Source1–10), Tuner with
FM/AM/DAB/XM, `DSP.Version` (except T765). Only **T755** lacks Zone 3/4, video and
CEC keys. M15HD (Masters-series pre-pro) parsed at **260 commands** — full Zone 2/3/4,
tuner and CEC, same first-gen profile as the AVRs.

## Verdict per model

- **Fully (with the app as written, incl. live signal + source names + Dirac):**
  only the **V3/MDC generation** the app targets — T 777 V3 (and close siblings
  T 758 V3/V3i, T 778, T 777 V2, M17/M17 V2) that share the V3 firmware vocabulary
  + BluOS + Dirac.
- **Substantially (all core + most setup; tuner presets and HDMI ARC work via the
  alias resolver; *no* live-signal panel, *no* device source names, *no* auto-standby
  — those have no first-gen equivalent and are greyed out):** T777, T787, T785, T187,
  T775, T765, T175, **M15HD** (first generation). Tuner, zones, tone, speakers,
  Dolby/DTS all work.
- **Partially:** T755 — core control + Zone 2 + tuner work, but **no Zone 3/4**,
  **no video** and **no CEC/ARC**; reduced bass-management subset.
- **Not at all:** anything pre-V2 (legacy non-ASCII NAD protocol) and devices driven
  only by BluOS / an MDC2 module (e.g. C 399/C 389, M10 streamers) — a different
  control surface, not this AVR protocol.

## What the runtime discovery does

On connect the app fires a `?` for each probe key (including alias spellings); the
device answers only for keys it implements (silence = unsupported). After a 4 s window
it classifies every capability `supported / unsupported / unknown`, probes BluOS
(:11000) and Dirac (:5006) out of band, and the UI hides or greys out whatever the
device didn't acknowledge — so one binary adapts to any NAD on the shared V2.x
protocol. See `apps/api/src/nad/capabilities.ts` and `apps/api/src/nad/aliases.ts`.
