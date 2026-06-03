# AUDYT compliance — FAZA 1 (audyt, potem STOP)

Gałąź robocza: `chore/compliance-rebrand-prep`. Bez `git push`.
To NIE jest deklaracja legalności — rozdzielam: „do naprawy w kodzie" vs
„wymaga człowieka/prawnika". Po tej fazie **STOP** — czekam na decyzję o nazwie.

---

## 1. Klasyfikacja wystąpień marek (A / B / C)

Łącznie (bez `node_modules`, `.git`, `dist`, plików generowanych):
**NAD 378 · BluOS 363 · Bluesound 0 · Dolby 52 · DTS 32 · Dirac 58.**

### (A) CHROME / nasz branding — DO ZMIANY
| Co | Gdzie | Obecnie → docelowo |
|---|---|---|
| Nazwa produktu | `apps/web/index.html:6` `<title>` | „NAD T 777 — Overlay" → `[PRODUCT_NAME]` |
| Nagłówek UI | `apps/web/src/App.tsx:112` `<h1>` | „NAD T 777 overlay" → `[PRODUCT_NAME]` |
| package.json | `package.json:2,5`; `@nad/api`, `@nad/web` | name „nad", desc „NAD T 777 V3…", scope `@nad` → neutralne |
| Badge stanu | `App.tsx:167` | „NAD OK" → „Amplituner OK" |
| Badge streamingu | `App.tsx:169`; i18n `bluos.ok/down`, `badge.bluosDownHint` | „BluOS OK/down" → „Streaming OK/—" |
| „Moduł BluOS" | i18n `bluos.module`, `bluos.reboot*` | → „Moduł streamujący" |
| „BluOS presets/unreachable", „(BluOS)", crumb „BluOS" | i18n `play.presets`,`play.unreachable`; `App.tsx:486,542` | → „Streaming" / „Presety streamingu" |
| Teksty `play.explain/autoSwitch/noBluos/onBluos` | `i18n.ts` | słowo „BluOS" (jako nasz tekst) → „moduł streamujący" |
| Etykiety capability | `App.tsx:62-63`, `CAP_LABELS`, `capabilities.ts` labels | „BluOS streaming" → „Streaming"; „Dirac Live (:5006)" → ukryć (flaga) |
| Dirac w chrome | `App.tsx:1028`, i18n `sys.diracAbsent`, `styles.css` | usunąć markę z UI; Dirac za `DIRAC_ENABLED=false` |
| Marketing/instrukcja | `README.md`, `tools/make-manual-pdf.mjs`, `NAD-COMPATIBILITY.md` (nazwa pliku), `dist-docs/…Manual.pdf` (nazwa) | rebranding tekstów + nazw plików |
| Narzędzia diag. | `tools/NAD-diagnostyka.bat`, `tools/nad-diag.ps1` (NIEśledzone) | „NAD" w nazwie/treści → rebrand |

### (B) DANE Z URZĄDZENIA — ZOSTAWIĆ (apka tylko renderuje)
- `state.ts:189-205 buildSourceNames()` — czyta `Source{i}.Name` z amplitunera;
  regexy `/tuner/i` i `/blu\s*os/i` wykrywają, który indeks źródła to tuner/BluOS.
  To są **etykiety wejść zwracane przez urządzenie**, nie nasz branding. Dodać komentarz.
- `App.tsx SourceGrid` (`:195`, `:388`, `:699`) — przyciski źródeł pokazują
  `state.sourceNames` z urządzenia (mogą zawierać „BluOS"/„Tuner"). Zostawić.
- `App.tsx:171` — badge `{nad.model} {nad.version}` to model raportowany przez
  urządzenie (np. „T 777"). Zostawić (dane urządzenia).

### (C) OSS / techniczne — ZOSTAWIĆ
- Klucze protokołu: `Main.Dolby.*`, `Main.DTS.*`, `Main.Audio.*`, `Main.CEC.*`,
  `Tuner.Band` (w `client.ts`, `state.ts`, `capabilities.ts`, `settings.ts`,
  `types.ts`). To identyfikatory protokołu NAD V2.x — wymagane, nie branding.
- `LISTENING_MODES = ['…','DolbyDigital','DTS','…']` (`App.tsx:310`) — to **wartości
  enum protokołu** wysyłane jako `Main.ListeningMode=…`. Muszą zostać (techniczne).
- Komentarze w kodzie odnoszące się do NAD/BluOS/Dirac — techniczne, zostają.
- Nazwy katalogów `apps/api/src/nad/`, `bluos/` — wewnętrzne, nie user-facing.
- Etykiety „Dolby Center Spread", „DTS DRC" itd. (`App.tsx` karta surround) — to
  OPISOWE etykiety funkcji urządzenia (bez logo). Niskie ryzyko; rekomendacja: zostawić.

---

## 2. Licencje zależności trafiających do .exe

Z produkcyjnego zasięgu zależności (`@nad/api` → .exe, `@nad/web` → UI):
**72 pakiety: 63× MIT, 6× ISC, 3× BSD-3-Clause.**
**COPYLEFT (GPL/AGPL/LGPL/MPL/SSPL): BRAK — 0 wystąpień.** Brak blokera.
Osadzony runtime: Node.js (MIT) + OpenSSL (Apache-2.0) + V8 (BSD) + ICU (Unicode) — permisywne.
(Plik `THIRD-PARTY-NOTICES.txt` już istnieje; w Fazie 2 dochodzi zmiana `legalComments`.)

---

## 3. esbuild + higiena dokumentacji protokołu

- `tools/build-exe.mjs:52` → `legalComments: 'none'` — **DO ZMIANY** na `'eof'`/`'linked'`
  (Faza 2, pkt 4), by zachować nagłówki licencyjne w bundlu.
- **Brak** śledzonych w repo PDF-ów/tekstów dokumentacji protokołu NAD/BluOS
  (oficjalne listy komend były tylko lokalnie w `/tmp`, nie w repo). DOBRZE.
- Jedyny PDF w drzewie: `dist-docs/NAD-T777-Overlay-Manual.pdf` — to WŁASNA instrukcja
  aplikacji (generowana, w `.gitignore`), nie cudza dokumentacja. Nazwa pliku do rebrandingu.

---

## 4. Propozycje neutralnej nazwy + plan rebrandingu

### 3 propozycje (bez „NAD/BluOS/Dirac")
1. **AmpDeck**  ← **REKOMENDACJA**. Krótkie, brandowalne, neutralne („amp" = wzmacniacz,
   „deck" = pulpit/konsola sterująca). Łatwe `.com`/`.app`, dobre jako nazwa produktu i pakietu.
2. **SoundHelm** — „helm/ster" nad dźwiękiem; sugeruje panel kontroli. Trochę dłuższe.
3. **ReceiverIQ** — opisowo-„inteligentny panel amplitunera"; generyczne, bezpieczne,
   ale mniej wyróżniające się.

**Rekomendacja: `AmpDeck`** (najkrótsza, najlepiej brandowalna, zero kolizji z markami sprzętu).

### Plan rebrandingu (Faza 2) — mapa dokładnych podmian
- Wprowadzić jedną stałą `PRODUCT_NAME` (np. w `apps/web/src/i18n.ts` lub osobnym
  `branding.ts`) + użyć jej w `<title>`, `<h1>`, „O programie", metadanych.
- `package.json` name „nad" → `ampdeck`; `@nad/api`→`@ampdeck/api`; `@nad/web`→`@ampdeck/web`;
  description → „[PRODUCT_NAME] — lokalny panel sterowania amplitunerami (kompatybilny z NAD)".
- Etykiety (i18n + App.tsx):
  - „NAD OK" → „Amplituner OK"
  - „BluOS OK"/„BluOS down" → „Streaming OK"/„Streaming —"
  - „Moduł BluOS" → „Moduł streamujący"; „BluOS presets" → „Presety streamingu";
    „BluOS unreachable" → „Streaming niedostępny"; „(BluOS)" → „(streaming)";
    crumb „BluOS" → „Streaming"
  - capability „BluOS streaming" → „Streaming"; „Dirac Live (:5006)" → ukryte (flaga)
- **NIE** ruszać: nazw źródeł z urządzenia (B), kluczy/enumów protokołu (C),
  logiki limitu głośności ani wykrywania funkcji.
- Kompatybilność — jednorazowo, opisowo (O programie/README/opis sklepu):
  „[PRODUCT_NAME] (kompatybilny z BluOS)" oraz „kompatybilny z amplitunerami NAD" + disclaimer.
- Pliki: `NAD-COMPATIBILITY.md`, `dist-docs/…Manual.pdf`, `tools/NAD-diagnostyka.bat`,
  `tools/nad-diag.ps1` → nazwy bez „NAD".

---

## 5. STOP — co dalej

Faza 1 zakończona. **Zatrzymuję się i czekam na Twoją decyzję co do nazwy**
(rekomendacja: **AmpDeck**) — dopiero po potwierdzeniu zaczynam Fazę 2 (rebranding +
BluOS/Dirac reguły + noty/licencje + disclaimer/EULA/prywatność/regulamin + maile do
Lenbrook/Dirac + checklisty). Nie wprowadzam żadnych zmian w kodzie przed Twoim „OK".
