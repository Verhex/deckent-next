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

## Onuncu parti (`integrate/2026-09-29-k`, worktree `/home/alperen/deckent-next-integrate-k`, taban `9a3ef2c`)
- Birleşenler (her biri `--no-ff`): FASTURI-OUT `178ab19d` (yayın paketinde MCP SDK'nın gömülü ajv/fast-uri'si yok; stub + build kapısı; MCP server
  cf-worker doğrulayıcısıyla), DEPS-TYPES `c8f86a23` (SDK girişi açık liste + envanter testi, 6 canlı zod değeri çıktı — BREAKING; d.ts kapanışı +
  vendored tipler, TS 5.9/6.0/7.0 × NodeNext/Bundler 0 hata), SECRET-K1 `6892a9c0` (`SecretStore` portu, env/file arka uçları, tek üretim çözücüsü,
  `doctor`, `secret list`; arch kenarları `c58ba8a9`), SHELL-OVERLAY `ee854a85` (full-auto kabuk yazım kümesi, bwrap ≥ 0.11; üretimde uykuda).
  Kanıtlar `proof/<KART>-2026-09-29/`.
- Entegrasyon düzeltmeleri:
  - `508fe854` composition bütçesi: 5510 > 5500 → bütçe yükseltilmeden saf host-shell sorumlulukları (`shellWritePosture` + `ShellCallAuthority`,
    `sandboxWriteSetRoot`, `agentShellEffectCommandId`, kabuk sonuç notları + etki reddi metni) `adapters/core/host-shell`'e bayt bayt taşındı →
    5432 satır (68 pay); host-shell birimine `engine/core/shell-classification`, `platform/core/host`, `platform/core/managed-files` kenarları eklendi.
  - `8cb7cbcd` SECRET-K1 i18n deltası: 8 hata metni en/tr (render'lar `error.unknown` yerine kendi anahtarı), `config.field.secrets` metadata,
    `doctor.secretStore` insan satırı, `secret list` yardım satırı (fixture güncellendi). **Sapma:** önerilen metinlerdeki "secret <kelime>" hata
    redaktörüne takılıyordu — derlenmiş CLI'da "The secret [REDACTED] …" (en/tr); metinler "secret-store" / "secret'lar deposu" biçimine çevrildi,
    16 metnin hiçbiri redaktöre takılmıyor; redaktör değişmedi. Diğer üç şeridin i18n deltası yok (SHELL-OVERLAY metinleri modele giden İngilizce).
- Doğrulama (tam verify değil): typecheck 0; eslint değişenlerde 0 hata (önceden var olan 2 uzunluk uyarısı); lint-arch 0 ihlal; `npm run build` ✓;
  hedefli vitest: i18n/yardım/secret/MCP/kabuk/dist 24 dosya 208 geçti + 3 atlandı (yerel `.pack/bwrap` yokken) → `.pack/bwrap/x86_64/bwrap`
  (lock sha `f5112648…` eşleşti, shell-overlay şeridinden kopya) ile overlay testleri 3 dosya 21/21; `runtime-chat-turn` + landlock 76/76;
  izin modu/ürün durumu/scratch 22/22; metin değişikliği sonrası i18n + secret 10 dosya 80/80. Derlenmiş CLI (geçici HOME): env `secret list`
  → `SECRET_STORE_UNSUPPORTED` temiz metin en/tr; file arka ucu 0644 → `doctor` "Secret store: core.secret-store.file@1 (unsafe,
  SECRET_STORE_UNSAFE)" ve `secret list` tipli ret en/tr; 0600 → ad listesi ve "(ready)".
  - Gerçek ikili e2e `kernel-config` SECRET-K1 birleşmesinden beri kırmızıydı (`doctor --json` anahtar listesinde `secretStore` yok) →
    beklenti güncellendi (anahtar, varsayılan env deposu raporu, tr insan satırı); e2e 4 dosya + SDK envanteri 22/22.

## On birinci parti (`integrate/2026-09-29-l`, worktree `/home/alperen/deckent-next-integrate-l`, taban `0a69a70` = onuncu parti adayı)
- Birleşenler (`--no-ff`): MCP-SCHEMA-VALIDATOR `5330cb7e` (kendi JSON Schema doğrulayıcımız cf-worker'ın yerine; arch.json kenarı), BWRAP-SELECT `e194b344`
  (launcher seçimi, gömülü bwrap 0.13, `ShellCapabilities` v2, paketleme, CI iş tanımı). Ayrıntı ve açık owner maddeleri PLAN "On birinci parti".
- Entegrasyon: Astra 2177 kopya testi kendi doğrulayıcıya uyarlandı; SHELL-OVERLAY yazım kümesi `launcher.overlay` ile **üretimde etkin** (Astra 2170 duruş
  testlerinin bwrap full-auto kolu yazım kümesi sonucuna güncellendi); test altyapısı `77d0d2f9` (build gömülü bwrap'ı aşamalar, gerçek-sandbox guard testi,
  vitest geçici `DECKENT_GLOBAL_HOME`); Astra 2180 R2 testi `e1380841` (0a69a70'te kırmızı, burada yeşil; uyarlama notu proof'ta); belge commit'i.
- Doğrulama (tam verify değil, lead koşacak): typecheck 0; eslint değişenlerde 0 hata (önceden var 3 uzunluk uyarısı); lint-arch 0 ihlal 0 uyarı; `npm run build` ✓
  (`bubblewrap=staged from .pack/bwrap/s6-check`, dist kopyası sha `917f8e7f…` = kilit); hedefli vitest (VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı
  değişkeni) 59 dosya **775/775, 0 atlanan**, `~/.deckent` değişmedi; overlay kanıtı: `runtime-shell-overlay.test.ts` üretim sandbox listesi ve servisin
  kendi ölçümüyle (`write set: applied 6`), `shell-overlay-write-set.test.ts` seçilen launcher ile + overlay'siz ölçülen launcher'ın yazım kümesi isteğini
  reddettiği negatif durum; guard negatif kanıtı: aşamasız 1 başarısız ("/usr/bin/bwrap 0.9.0 < 0.12.0"). build-dist `--bwrap` → `bubblewrap.shipped: true`,
  tarball'da `linux-x64/bwrap` 0755 + NOTICE/lisans/kaynak, cf-worker/ajv kodu yok (yalnız vendored d.ts yorumları); paketlenmiş dist'ten seçim: `bundled`,
  `overlay: true`, kopya 0500; pack-smoke Node 24.21 ✓ ve 26.10 ✓. `deps-watch` (güncellenmiş kayıtla) çıkış 0, HIGH 0, MITIGATED 16.
- Bilinen sınırlar: AppArmor `restricted` yolu gerçek Ubuntu'da ölçülmedi; CI `bwrap-bundle.yml` koşmadı; ana `ci.yml` bwrap aşamalamıyor (guard kısıtsız
  koşucuda düşer); seçilen launcher denemesi düşerse sıradaki adaya geçilmez; MCP sunucu görünümü hâlâ salt okunur (overlay MCP yolu sonraki dilim);
  `format` artık yalnız açıklama; `.pack/bundled-aside` (gitignore) test artığı, owner silebilir.

## Sıradaki
1. Push adayı `9a3ef2c` (dokuzuncu parti, H+I+J): Astra 2179 incelemesi → PASS'te push.
2. Onuncu parti (`integrate/2026-09-29-k`): tam verify → Astra → PASS'te push.
2a. On birinci parti (`integrate/2026-09-29-l`): lead lane/shell-overlay Astra 2180 R1 düzeltmesini birleştirir → tam verify (gömülü bwrap aşamalı) →
   Astra → PASS'te push.
3. DEPS-P0 ilk push'tan sonra başlar.
4. Owner kararları: PLAN "Onuncu parti" açık kararları (secret set|delete yetkisi A/B/C — lead önerisi A; SHELL-OVERLAY O1/O3/O5/O6/O7;
   JSON Schema doğrulayıcısı + ReDoS — on birinci partide kapandı, yerine `format` / şema korpusu ölçümü / AppArmor / CI maddeleri; DEPS-SCHEMA C1 kanıtı) ve sabah listesi
   `proof/MORNING-REPORT-2026-09-29.md` (P1 tasarımları: OTel / uzak MCP, anahtar zinciri K2; zod 4 hata kodları; MCP sandbox seçenekleri B/C/D/E
   + tur başı `notice` olayı (v18); DEPS-DIST yayın engelleri (LICENSE, gömülü lisans metinleri) ve DEPS-DIST-B1; ANTHROPIC ilk faturalı duman
   çağrısı ve legacy tarifeler; fast-uri kabul edilmiş riski (2026-10-29); canlı geçiş).

## Açık kalanlar
- Owner tasarım onayları (2026-09-29): soru kartları A, terminalden Agent OS O1, DECKENT.md Öneri 1 — uygulama dilimleri bu partiden sonra (owner: yeni iş yok).
- SHELL-AUTONOMY açık owner soruları: C1 program tabanı sandbox'ta, C2 audit event v2 (realm/hücre); `run_shell` model açıklaması sürümü
  (C3 → full-access, C4 → yazım duruşları ile kapandı).
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek; ret kodunda uç nokta/ledger ayrımı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
