# CHANGES.md — Faza 2 (naprawa compliance przed sprzedażą)

Gałąź: `chore/compliance-rebrand-prep`. Bez `git push`. Nazwa produktu: **Receiver HQ**.
**To NIE jest deklaracja legalności.** Poniżej rozdzielono: ✅ naprawione w kodzie/dystrybucji
vs ⏳ WCIĄŻ WYMAGA CZŁOWIEKA. Logika limitu głośności i wykrywania funkcji — NIETKNIĘTA.

## ✅ Zrobione w kodzie / dystrybucji

### Rebranding → „Receiver HQ"
- Nowa stała `apps/web/src/branding.ts` (`PRODUCT_NAME`, `COMPAT_LINE`, `DIRAC_ENABLED`).
- `<title>` (index.html), nagłówek `<h1>`, `document.title` → Receiver HQ.
- `package.json` (root: `receiver-hq` + opis), `@nad/api`→`@receiver-hq/api`,
  `@nad/web`→`@receiver-hq/web`; zaktualizowane filtry pnpm w `build-exe.mjs` i skrypt `probe`.
- Bannery startowe + nazwa pliku konfiguracji: `nad-config.json`→`receiver-hq-config.json`;
  exe: `nad-overlay.exe`→`receiver-hq.exe`.
- Badge „NAD OK"→„Amplituner/Receiver OK".

### Marka BluOS usunięta z chrome (reguły API)
- `i18n.ts`: wszystkie nasze etykiety/statusy → „Streaming"/„Moduł streamujący".
  **Wystąpień „BluOS" w i18n: 99 → 0** (PL/EN/DE + manual).
- Badge, nagłówek now-playing, breadcrumb biblioteki, presety, capability label → neutralne.
- Nazwy źródeł z urządzenia (`SourceN.Name`, detekcja `/blu\s*os/`) — ZOSTAWIONE jako
  dane urządzenia; komentarz w `state.ts`, że to etykiety wejść, nie nasz branding.
- Jedna OPISOWA linia kompatybilności w „O programie" (`about.compat`): „kompatybilny z BluOS".

### Dirac — domyślnie wyłączony (najwyższe ryzyko)
- `DIRAC_ENABLED=false` w web (`branding.ts`) i api (`capabilities.ts`).
- api: brak sondowania portu :5006, gdy wyłączone (`state.ts`).
- web: ukryta linia Dirac w „Urządzenie" i pozycja Dirac w panelu Kompatybilność.
- Marka „Dirac" usunięta z chrome.

### Noty licencyjne OSS
- esbuild `legalComments: 'none'` → `'eof'` (zachowuje nagłówki licencji w bundlu).
- `THIRD-PARTY-NOTICES.txt`: 72 pakiety produkcyjne — **63 MIT / 6 ISC / 3 BSD-3, ZERO copyleft**
  + Node.js/OpenSSL. Kopiowany obok exe przez build (`build-exe.mjs`).

### Disclaimer + UI „O programie" + pierwsze uruchomienie
- `DISCLAIMER.txt` (PL+EN) — znaki towarowe, brak powiązania, bezpieczeństwo, AS-IS.
- Karta „O programie" (zakładka System): kompatybilność + disclaimer + odesłanie do not.
- Jednorazowy komunikat przy pierwszym uruchomieniu (bezpieczeństwo głośności +
  niezależność/marki), zapamiętywany w `localStorage`.

### Dokumenty prawne / sprzedażowe (szablony PL+EN, do przeglądu prawnika)
- `EULA.txt` (PL + skrócona EN; Receiver HQ; carve-out interoperacyjności; zastrzeżenie
  głośności; prawa konsumenta).
- `PRIVACY.md` (PL+EN; działanie lokalne, RODO).
- `REGULAMIN.md` (PL+EN; prawo odstąpienia treści cyfrowej + checkbox zgody; rękojmia).
- `COMPLIANCE.md` (mapa wymagań polityki API BluOS → implementacja).

### Higiena
- Brak cudzej dokumentacji protokołu NAD/BluOS w repo (potwierdzone w Fazie 1).
- README: tytuł + nota o znakach towarowych/braku powiązania + linki do dokumentów.

### Bezpieczeństwo nietknięte
- Logika limitu głośności (limit, krok ≤ MAX_STEP, ostrzeżenie, watchdog, strefa
  „strzeżona") oraz runtime capability discovery — bez zmian. Testy: 22/22.

## ⏳ WCIĄŻ WYMAGA CZŁOWIEKA (kod tego nie załatwi)
1. **Finalna ocena nazwy/znaku „Receiver HQ"** i opisowego użycia marek — prawnik IP
   (PL/UE). Sprawdzić kolizje (EUIPO/UPRP). Patrz `LAWYER-CHECKLIST.md`.
2. **Wysłać `LENBROOK-EMAIL.md`** — pisemna zgoda na opisowe użycie BluOS + stanowisko
   ws. komercyjnego użycia API/protokołu.
3. **(Opcjonalnie) `DIRAC-EMAIL.md`** — tylko jeśli kiedyś włączysz Dirac.
4. **Przegląd prawnika** EULA/Regulaminu/Polityki prywatności (prawo konsumenckie PL/UE,
   VAT/MOSS, prawo odstąpienia).
5. **Potwierdzić własność praw do kodu** (brak cesji na pracodawcę/zleceniodawcę).
6. **Status działalności** (zawieszona JDG + bezrobotny) — urząd pracy + księgowy.
7. Uzupełnić pola `[ ]` w dokumentach (dane firmy, adres, e-mail, miasto sądu, rok, ceny).

> Nie deklarujemy, że produkt jest „legalny". Po zamknięciu punktów ⏳ ryzyko spada
> z „nie startuj sprzedaży" do poziomu akceptowalnego — decyzję podejmij z prawnikiem.
