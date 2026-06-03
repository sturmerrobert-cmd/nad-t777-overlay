# COMPLIANCE.md — mapowanie wymagań do implementacji (Receiver HQ)

> Jak Receiver HQ adresuje typowe klauzule polityki API BluOS (Lenbrook) oraz
> zasady marek. NIE jest to deklaracja legalności ani potwierdzenie zgody Lenbrook
> — pisemna zgoda/stanowisko Lenbrook jest WCIĄŻ DO UZYSKANIA (patrz LENBROOK-EMAIL.md).

| Wymóg / klauzula | Jak adresujemy w kodzie/dystrybucji | Status |
|---|---|---|
| Brak użycia marki w brandingu (zero „BluOS" w chrome) | Wszystkie nasze etykiety/statusy zmienione na „Streaming"/„Moduł streamujący"; zero „BluOS" w `i18n.ts` (99→0). Nazwa produktu: Receiver HQ. | ✅ w kodzie |
| Dozwolone użycie opisowe marki | Jednorazowa linia w „O programie"/README/sklepie w formacie „kompatybilny z BluOS"; nigdy „[Produkt] - BluOS" / „Powered with BluOS". | ✅ w kodzie; ⏳ zgoda Lenbrook |
| Nazwy źródeł z urządzenia | Renderujemy `SourceN.Name` z amplitunera bez modyfikacji; nie wstrzykujemy marki do statycznych stringów (komentarz w `state.ts`). | ✅ w kodzie |
| Pokazana polityka prywatności | `PRIVACY.md` (PL+EN), link w „O programie". | ✅ szablon; ⏳ wdrożenie linku/treści |
| Brak konkurowania z usługą/marką | Produkt to lokalny panel STEROWANIA sprzętem; nie tworzy konkurencyjnej usługi streamingu, nie podszywa się pod aplikację dostawcy. | ✅ z założenia |
| Brak reverse-engineeringu ponad dozwolony | Używamy publicznie udokumentowanego protokołu sterującego urządzenia + lokalnych interfejsów; EULA zawiera carve-out interoperacyjności (2009/24/WE). | ✅ w kodzie; ⏳ ocena prawnika |
| Usuwanie danych na żądanie | Dane są lokalne; użytkownik czyści je w aplikacji („Wyczyść") lub kasując pliki. | ✅ w kodzie |
| Bezpieczeństwo | Działanie w LAN; brak chmury; krótkie timeouty; brak składowania danych po naszej stronie. | ✅ w kodzie |
| Użytek profesjonalny / integracyjny | Pozycjonowanie jako narzędzie sterowania; disclaimer o braku powiązania i wsparcia. | ✅ w kodzie |
| Ryzyko Dirac (marka + nieoficjalne API) | `DIRAC_ENABLED=false` (web i api): brak sondowania :5006, ukryte UI; marka Dirac usunięta z chrome. | ✅ w kodzie; ⏳ zgoda Dirac jeśli kiedyś włączane |
| Atrybucja OSS | `THIRD-PARTY-NOTICES.txt` (72 pakiety + Node/OpenSSL); esbuild `legalComments:'eof'`. | ✅ w kodzie |

**Uwaga:** powyższe to mapowanie najlepszych praktyk do implementacji. Wiążącą
wykładnię polityki API BluOS i kwestie znaków towarowych musi potwierdzić Lenbrook
i/lub prawnik IP (patrz LAWYER-CHECKLIST.md).
