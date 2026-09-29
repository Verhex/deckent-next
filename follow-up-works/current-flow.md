# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-29, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `0e0ca63` (altıncı parti; Astra 2167 PASS, kanal REVIEW 2168). Canlı servis `0e0ca63` build'iyle (instance `f810508e…`, owner onayı
  "Şimdi geç"; kanıt `proof/LIVE-SWITCH-BATCH5-2026-09-28/BATCH6-README.md`), ledger v42, `service.responseMaxBytes` 4 MiB → satır modu yanıt veriyor;
  canlı policy v2. Geri dönüş: `dd63fd9` build'i + `config-before-batch6.json`. DOGFOOD OFF.
- Canlı geçişte görülen küçük bulgular: bwrap içinde `ls .deckent/live-data/state` giriş adlarını listeliyor (içerik maskeli, ad düzeyinde meta veri);
  terminal kapanınca onay bekleyen tur onay TTL'i (9 dk) dolana kadar `running` kalıyor.
- Ana checkout `dd63fd9` + `0e0ca63` ff; Astra/owner WIP'i (core-memory, `hemen-donulecek-is.md`, `auto-edit-test.txt`) korunuyor; Astra 2167 notları
  yamada (`.deckent/host/reviews/astra-main-notes-2026-09-29-live6.patch`) ve aşağıya işlendi.

## Astra 2167/2168 (2026-09-29)
- Aday `0e0ca63`: kapsamlı olmayan bağımsız **PASS** (2166 wildcard ürün yolu kapandı: desteklenmeyen etkili yol typed admission reddi; normal/bracket/brace
  desteği korunuyor). İzole build + native, lint-arch 0, 95/95 hedefli test; gerçek servis başlangıcı ve iki realm'de onaylı tur kanıtı. Opus tam verify logu
  okundu (412/2763, exit 0; bağımsız tekrar yok). Kanıt `proof/ASTRA-2167-2026-09-29/review.md`; Jev 540a8645 PASS 0,99, yeterlilik 0,79 (tavsiye).
- Takip: `model-invocation-process` geçici 45 s sınırı yedinci partide kaldırıldı (`3bb8058`, STARTUP-COST sonrası ≈24 s ölçüldü) — tam verify ile
  doğrulanacak; `LAYOUT_*` typed kodlarının i18n metni küçük takip.

## Yedinci parti (`integrate/2026-09-28-h`, worktree `/home/alperen/deckent-next-integrate-h`, taban `5b267a9` + main `0e0ca63`)
- Birleşenler (her biri `--no-ff`):
  - SESSION-RESULT-LIMIT `c67302c` (doctor `modelInvocationDelivery`, `MODEL_ACTIVATION_DELIVERY_UNFIT`).
  - POLICY-ADMIN P1–P3 `6e76c42` → POLICY-HARDEN P3-R `3e01b90` (yetki onayı yalnız yetki yüzeyinde `APPROVAL_SURFACE_RESTRICTED`, settle anında ret,
    `authority-refusal` audit, redakte kart farkı).
  - MCP-CLIENT `4cc7ca0` → `afb7518` (kapsamlı kayıt dosyaları, `mcp.clients` config'ten kalktı) → `db5121d` (add = güven, ilk kullanım kartı, `/mcp`).
  - MCP SDK 2.2.0 + sayfalı araç listesi `d934c5b`; STARTUP-COST `3f879c6` (Ink ve MCP server SDK statik grafikten çıktı).
  - MODE-UX G3 `fd3c5e4`; PERSISTENT-APPROVALS G6 `d389bee` (kapsam seçmeli kalıcı onay; tel v17 ve servis kablosu açık).
  - SANDBOX-SPEED G2 `1ed884d`; TERM-UX-1 `3dbbed7`; ANTHROPIC-PROVIDER G8 `50d86ce` (checkpoint A/B açık).
- SHELL-AUTONOMY birleşti: `9dd8dac` + `9679020` (mod gevşetmesi önce, kalıcı onay son); Astra 2170 düzeltmesi `33f0bec` (testler) + `bbd57f0`
  (üç yazım duruşu; CLI MCP başlangıcı `writeFloor` taşır, eşleyicisiz kapalı başarısız). C5 açık → PLAN SHELL-OVERLAY.
- MODES-3 birleşti: `7fbe476` (kod+test) + `5149c1f` (katalog metinleri), birleştirme `36ee9db` → `d8fb13a` (tek yazım duruşu türetimi `450edd9`,
  Landlock oyma tabanı `869c01f`). Kanıt `proof/MODES-3-2026-09-29/`; canlı göç `review.md` §6 (betik `migrate-live-modes.mjs`, önce dry-run).
  Owner checkpoint cevapları 2026-09-29: full-access'te fetch-unlisted deneme; `ask` → standart+askEdits; etkileşimli ilk kurulum owner tasarlar.
- Astra 2169/2170 REVISE (`6a09a76` üzerinde) karşılandı; belge deltası bu commit'te.
- Lead düzeltmeleri: MCP client SDK'sı tembel yükleniyor (`e7d6553`); 0e0ca63 ↔ MCP kayıt dosyası ajan deny listesi (ürün durumu deny'ı + `.deckent/mcp.json`);
  `surfaces/core/terminal` birim bütçesi (2000) aşımı iki bağımlılıksız parçanın taşınmasıyla çözüldü (kart tuş eşlemesi → `terminal-kit`, `ArrowPicker` →
  `terminal-render`); deny eşleyicisi hızlı yolu platformun tek `GLOB_WILDCARD` tanımını kullanıyor; `APPROVAL_SURFACE_RESTRICTED` ve MCP güven/`/mcp`,
  TERM-UX-1 metinleri en/tr + kayıt; MCP güven deposu okunamazsa typed hata.
- lint-arch 0 ihlal (`d8fb13a`, belge güncellemesinde ölçüldü).
- Sonra MCP-VALIDATOR (`f6bd9d3`) ve belge commit'leri eklendi; parti adayı `ce2440f`.

## Sekizinci parti (`integrate/2026-09-29-i`, worktree `/home/alperen/deckent-next-integrate-i`, taban `ce2440f`)
- Birleşenler (her biri `--no-ff`): MCP-PIN-DEF `c30a651` (pinlenmiş tanım `toolDefinition`, -32020 yeniden gönderilmez, structuredContent
  doğrulanır); DEPS-SCHEMA `2947c81` + arch kenarı `59d9403` (kayıt `optionsSchema` Standard Schema v1); DEPS-GOV `1c76748` + `3680370` + `b5369fd`
  (`dependencies.json`, lint-arch dış import kapısı, `deps-watch`, kabul edilmiş riskler; fast-uri girdisi 2026-10-29'da biter); ANTHROPIC-PROFILE
  `3be2c7a` (model yetenek kaydı, `effort`, adapter v2); GIT-NET `37be829` … `b838569` (birleştirme `dda792e`; `protocol.allow=never` +
  `GIT_ALLOW_PROTOCOL=''` + lazy fetch yok). Kanıtlar `proof/<KART>-2026-09-29/`. Belge deltası bu commit'te.

## Dokuzuncu parti (`integrate/2026-09-29-j`, worktree `/home/alperen/deckent-next-integrate-j`, taban `61a5eac`)
- Birleşenler (her biri `--no-ff`): ZOD4-PREP `ab3be14` (zod 3 oracle'ları: config varsayılan/hata şekli golden'ı, MCP `tools/list` inputSchema
  fixture'ı, sınır davranışları; çalışma zamanı değişmedi); MCP-SANDBOX-PATHS `07f9717` + lead takibi `0b24ead` (tipli teşhis
  `MCP_SANDBOX_COMMAND_UNREACHABLE`; turda/`/mcp`'de sessiz başarısızlık yok; `integrations/mcp-start-failures.json`); DEPS-DIST `5b58fa7`
  (`pack:dist` bağımlılıksız tarball + CycloneDX SBOM + `smoke:dist`). Kanıtlar `proof/<KART>-2026-09-29/`.
- Entegrasyon düzeltmesi (`ed8cffd`): MCP-SANDBOX-PATHS i18n deltası (`add` + `followUp`, 13 anahtar en/tr) uygulandı. Ret mesajı teşhis türüne göre
  üç katalog cümlesinden biri (rol etiketi yerelleştirilmiş); adaptör artık metin yazmıyor (`McpStartNotice`), tek render sahibi composition
  (`renderMcpStartNotice`): tur notu servisin locale'inde, `lastStart.text` (`/mcp`, `mcp list|get`) çağıran yüzeyin locale'inde. Testler: en/tr saf
  render, gerçek bwrap tur testi (en servis + tr servis notu, `/mcp` tr/en), kayıt testi reddi en/tr. İki mutasyon (servis locale'i yok sayılır; yüzey
  locale'i geçirilmez) testleri kırdı, geri alındı. Belge deltası (ARCHITECTURE/PLAN/CHANGELOG/current-flow) ayrı commit'te.

## Sıradaki
1. Yedinci parti `ce2440f`: Astra 2171 incelemesi → PASS'te push.
2. Sekizinci parti `61a5eac`: Astra 2172 incelemesi → PASS'te push.
3. Astra 2174/2175/2176 (06:45) üç partiye REVISE, ortak P1 (bekleyen eski MCP kartı güven kaldırıldıktan sonra gönderiyordu) → MCP-REVOKE `a5c2000` dokuzuncu partiye birleşti. Sıradaki: bu dalda tam verify → Astra'ya tek yeni sha (H+I+J) → PASS'te push; C5 owner kararı.
4. DEPS-P0 yedinci parti push'undan sonra başlar.
5. Owner sabah kararları: liste `proof/MORNING-REPORT-2026-09-29.md` — P1 tasarımları (anahtar zinciri / OTel / uzak MCP; önce K1 — üretimde
   `secretResolver` bağlı değil), DEPS-SCHEMA C1/C2 (= DEPS-DIST kütüphane tipleri engeli), zod 4 hata kodları (eşle / kabul et), MCP sandbox
   seçenekleri B/C/D/E + tur başı `notice` olayı (v18), DEPS-DIST yayın engelleri (tipler, LICENSE, gömülü lisans metinleri) ve DEPS-DIST-B1 kartı
   (271→133 ms), ANTHROPIC ilk faturalı duman çağrısı ve legacy tarifeler, fast-uri kabul edilmiş riski (2026-10-29), canlı geçiş (bindings v3 +
   MODES-3 canlı göçü, Node 24.21 varsayılan geçişi dahil).

## Açık kalanlar
- Owner tasarım onayları (2026-09-29): soru kartları A, terminalden Agent OS O1, DECKENT.md Öneri 1 — uygulama dilimleri bu partiden sonra (owner: yeni iş yok).
- SHELL-AUTONOMY açık owner soruları: C1 program tabanı sandbox'ta, C2 audit event v2 (realm/hücre); `run_shell` model açıklaması sürümü
  (C3 → full-access, C4 → yazım duruşları ile kapandı).
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek; ret kodunda uç nokta/ledger ayrımı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
