# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-29, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- **On yedinci parti (2026-09-30 gece; `integrate/2026-09-30-r`, worktree `/home/alperen/deckent-next-integrate-r`, taban `74ce44c4`, HEAD belge commit'inden önce `9758cceb`):**
  FA-TRACKED-WARN (`9e0bcf10`, v18'de yalnız sonuç metni), WORK-TARGETS dilim 1 (`f70c47ac`/`7f5c6d72`), WORKER-CURRENCY-2 (`ae6ce536`; owner kural A uygulandı — beyan edilen
  yardımcı serbest, beyan dışı model → deneme kabul edilmez, model çağrıları görünür), dogfood D2-1..D2-3 (`30988c66` → `4f823ee8`), TRUNCATED-TOOLCALL (`ba11dc77`, istem v7),
  CI-F8 CRLF (`f7848e07`), SURROGATE-OPENROUTER (`04892147`, yalnız ayrıştırıcı temizliği), COMPOSITION-RELIEF (composition 5520 → 5454), CI-TERMINAL-CLI (`8ff96a2d`).
  **Doğrulama durumu:** yalnız hedefli testler (lane kanıtları); tam verify yok. **Barındırılan CI (`30988c66`, koşu 36741640264) yerel verify'dan ayrı:** bwrap-bundle SUCCESS (ilk kez);
  ubuntu/Node24 3542 geçti 1 kaldı (→ ci-terminal-cli); Node26 2 kaldı (aynısı + F7); Windows F8 (bu partide); macOS ~425 F9 (kapsam dışı); CI-FIX C0–C2 kapanışı sonraki barındırılan koşuyu bekler.
  **Sıradaki:** tam verify (Docker imajı + bwrap'lı build) → **Sol** REQUEST_REVIEW (bağımsız inceleyen GPT-6.1 Sol, `astra` kanal adresi; owner 2026-09-30) → PASS'te push → canlı geçiş
  (owner onaylı yeniden başlatma; U1: canlı checkout yalnız o geçişte derlenir) → DEV-U2-0 şeridi (owner U2 seçenek C; Jev c2956e5d .94/.68) inince ilk DEV-U2-0 geçişi.
  Canlı config zaten değişti (owner onaylı, Jev 10d392b3 .94): `terminal.chat.maxCompletionTokens` 16384, `local-qwen` v7 `maxOutputTokens` 16384, `limits.timeoutMs` 600000
  (`service.responseTimeoutMs` yalnız son çerçeve yazımını sınırlar; model çağrısını profil `timeoutMs` sınırlar; kanıt `proof/MAX-COMPLETION-2026-09-30/`).
  Açık: `deckent models --help` `catalog` satırı (i18n-parity ile); ayrı `truncated` araç durumu (Jev 0,84, karar); D2 lead inceleme notları (PLAN); K3/K5/K6.
- **2026-09-30 akşam:** `origin/main` = `30988c66` canlıda (16. parti; instance `0c8a0709`, ledger v43). Owner K1–K9 kararları PLAN'da (ikame seçenek A **kararlaştırıldı**,
  17. partide uygulandı). Kanıt `proof/DOGFOOD-K-DECISIONS-2026-09-30`.
- **Canlı (2026-09-30, 15. parti):** `origin/main` = `47a76adf` (Astra 2194 PASS); instance `85d99b8d`, Node 24.21; tam erişimde model curl → HTTP/2 200
  (istem v6). Kanıt `proof/LIVE-SWITCH-BATCH15-2026-09-30/README.md`. **Sıradaki (owner 2026-09-30):** on altıncı parti (`integrate/2026-09-30-q`)
  dogfood D1-0..D1-2 + CI-FIX F1–F6 + WORKER-IMAGE-R4 + WORKER-CURRENCY-1'i birleştirdi (ayrıntı aşağıda; 30988c66 ile canlıya alındı).
- **On dördüncü parti (2026-09-30):** `integrate/2026-09-30-o` (worktree `/home/alperen/deckent-next-integrate-n`, taban `02601269`) =
  Astra 2189 REVISE düzeltmeleri: R7 ata pinleri (açık + kapalı yazılabilir görünüm; lane/r7-ancestor), gömülü bwrap kopya yarışı (link ile yayın),
  R8 doctor MCP launch kuralı (lane/r8-doctor-mcp). Tam verify 490/3467 0 skip (Docker imajıyla) → Astra 2190 PASS → `origin/main` = `51b19dc5` (push 2026-09-30).
  **Canlı (2026-09-30):** instance `6eb54a8c`, build main `979b4b02` (= `51b19dc5` + belge), Node 24.21, config `language: tr`;
  doğrulama: Türkçe yanıt, tam erişimde gerçek HOME, `.deckent/mcp.json` read-only, bubblewrap gömülü (bildirim yok), context7 ok.
  Canlı bulgu: tam erişim turunda istem "Network access: none" diyor → model ağı reddediyor; düzeltme lane/prompt-posture (istem v6).
  Kanıt `proof/LIVE-SWITCH-BATCH14-2026-09-30/README.md`. Birleşmiş worktree/dallar temizlendi.
- **On beşinci parti (2026-09-30):** `integrate/2026-09-30-p` (worktree `/home/alperen/deckent-next-integrate-p`) = PROMPT-POSTURE `37449c8a`:
  istem v6 kabuk duruşunu turun realm çözümünden (`createAgentShell().posture()`, çağrılarla aynı resolveRealm/callRealm) yazar —
  açık görünüm: ağ + gerçek HOME + proje/.git yazılabilir, Deckent durumu mühürlü; kapalı: ağ yok, HOME gizli; host: sandbox yok; fetch_url ayrı.
  Host realm'de standart/full-auto istemi de artık ağın erişilebilir olduğunu söyler (doğru, görünür değişiklik). requestDigest istem hash'i
  içerdiğinden eski turn id tekrarı AGENT_TURN_CONFLICT (bilinçli). Kanıt `proof/PROMPT-POSTURE-2026-09-30/`.
  Astra 2192 REVISE R9 P2 (istem config'i koşulsuz mühürlü diyordu; full-access içinde owner-approved çağrı mevcut config içeriğini yazabilir)
  → `0542196b`: yapısal taban (durum/policy/kimlik) ile config kuralı (onaysız salt okunur, onaylı çağrı mevcut içeriği değiştirebilir) ayrı;
  `posture().configuration` `shellWritePosture('owner-approved')` kaynağından; Astra reviewer testi gerçek serviste kırmızı→yeşil (r9/). Sıradaki: tam verify → Astra. Kanıt `proof/R7-R8-FIX-2026-09-30/`.
- **On altıncı parti (2026-09-30):** `integrate/2026-09-30-q` — dogfood ilk döngüleri D1-0..D1-2 Deckent'in kendi Run/verify/benimseme döngüsüyle
  benimsendi (N1 izole kurulum, topoloji a′: canlıya yazım yok; `c7b44469` → `844048e6` → `0e4fa003` → `b61b34b9`; lead test düzeltmesi `02cff460`;
  kanıt `../deckent-refactor-work/proof/DOGFOOD-D1-2026-09-30/README.md`); CI-FIX F1–F6 (Codex lane + lead F6 düzeltmesi `b9b2ce15`/`28f6bfe0`;
  required Linux job artık bwrap'ı aşamalıyor (F1–F3), PTY fixture CI'de yeşil (F4), git patch `ls-tree` BAD sentinel'i `PATCH_UNAVAILABLE` (F5),
  shared-ledger testi 5 adıma bölündü, en uzun adım ~7 s (F6); GitHub koşusu push sonrası gerekli, C0–C2 DONE/PASS yazılmadı; kanıt
  `../deckent-refactor-work/proof/CI-FIX-2026-09-30/`); WORKER-IMAGE-R4 (`0fd2df1b`; r4 imajı `sha256:bf6973ec…`, Claude 2.1.285/Codex 0.159.2/
  Cursor 2026.09.28; kanıt `../deckent-refactor-work/proof/WORKER-IMAGE-R4-2026-09-30/`); WORKER-CURRENCY-1 (`2231ac8f`; ledger v43 model kataloğu
  sağlayıcı kanalı başına, tam model ID pinleme (takma ad reddi), admission ret kodları, `model.verification`; kanıt
  `../deckent-refactor-work/proof/WORKER-CURRENCY-1-2026-09-30/`). Açık (16. parti anında; katalog CLI/MCP ve ikame kabul kapısı 17. partide
  WORKER-CURRENCY-2 ile kapandı): Codex/Cursor model kanıtı doğrulanmadı; verify imajında bwrap yok; ağaç dışı `node_modules` SBOM açığı sürüyor.
- **Canlı (2026-09-29 18:07'den beri):** yedinci–on ikinci partiler `4a2ac04` build'iyle canlıda; `origin/main` = `4a2ac04` (push `0e0ca63` → `9a3ef2c`
  Astra 2181 PASS → `4a2ac04` Astra 2186/2187 PASS). Instance `74e4359e` (ilk `0b044e1a`, global kök düzeltmesiyle yeniden başlatıldı), Node 24.21,
  protokol v18; eski v16 servisi eski build'in kendi CLI'ıyla durduruldu. Mod göçü dry-run → `--grant-full-access` (bindings v3 + owner full-access
  grant'ı, full-auto korundu); secret yetkisi `owner-secret-store` (`add-secret-grant.mjs`); secret deposu bilerek env (dosya arka ucu geçişi owner'la).
  Kanıt `proof/LIVE-SWITCH-BATCH12-2026-09-29/README.md`. Geri dönüş: `0e0ca63` build'i + yedekler (`migrate-backup/` v2 bindings). DOGFOOD OFF.
- **Canlı bulgu → düzeltme:** ilk kabuk kartı Landlock gösterdi; kök neden next-entry `DECKENT_GLOBAL_HOME` proje içinde → gömülü bwrap kopyası
  proje içinde → güvenlik kuralı reddetti (doğru) → Landlock'a bildirimsiz düşüş. Düzeltme: next-entry global kökü `~/.local/state/deckent-next-dev`
  (main `0360bab9`, push bekliyor; canlı build'in parçası değil), yeniden başlatma sonrası kart "Runs in a bubblewrap sandbox …"; ürün bildirimi
  REALM-NOTICE on üçüncü partide (`bwrap-fallback-investigation.md`).
- Küçük açıklar (kapanış kanıtı yok): bwrap içinde `ls .deckent/live-data/state` giriş adlarını listeliyor (içerik maskeli); terminal kapanınca onay
  bekleyen tur onay TTL'i (9 dk) dolana kadar `running` kalıyor.
- **Astra 2186 (`4a2ac04`) PASS:** R5/R6 kapandı, R1–R4 korunuyor; açık: önceden 1 MiB üstü store kurtarması yok, compact dış dosyada delete
  `SECRET_STORE_FULL` alabilir (dosya aynı/okunabilir). Ayrıntı PLAN "On ikinci parti".
- Ana checkout: Astra'nın yerel notları (stash `astra-main-notes-2026-09-29-live12` / `.deckent/host/reviews/…-live12.patch`) on üçüncü partiye
  işlendi; stash owner/Astra'nın, dokunulmadı.
- Aşağıdaki yedinci–on ikinci parti bölümleri canlıya alınmış partilerin entegrasyon kaydıdır (sonraki temizlikte COMPLETED-PLAN'a).

## Dış çalışma alanı sadeleştirmesi — Astra, 2026-09-29
Owner isteğiyle 7 tüketilmiş devir/plan belgesi ve 18 eski, referanssız kanıt girdisi
`../deckent-refactor-work/archive/2026-09-29-consumed/` altına arşivlendi (71 dosya; `moves.json` eski → yeni yollar, `README.md` geri alma).
Paket ayrı dizine açılarak ve taşınan özgünler SHA-256 ile doğrulandı; içerik silinmedi. `COMPLETED-PLAN.md`'deki beş tarihsel bağlantı
yeni yollara çevrildi (hedefler var); diğer iki belge ve 18 kanıt girdisine izli belgelerde referans yok. Manifest aracı sembolik bağları
izlemek yerine bağın kendisini sayıyor. Aktif kartlar, son üç günün kanıtları ve owner WIP'i yerinde; arşiv için bekleyen silme yok.

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

## On ikinci parti (`integrate/2026-09-29-m`, worktree `/home/alperen/deckent-next-integrate-m`, taban `6bb6f5f` = onuncu + on birinci parti adayı)
- Birleşenler (`--no-ff`): DEPS-P0 `c871a4a6` (LICENSE Apache-2.0, Node `>=24.15.0`, 10 yerde SQLite tabanı, react 19.2.8, CI Node [24, 26]; kilit dosyası
  yeniden üretildi = aynı, `npm ci`), SECRET-WRITE `dd323c0b` (`secret set|delete` servis üzerinden, `secret` policy hücresi, şablon v2; protokol v18).
  Entegrasyon: `f9650fd1` composition 5501 → 5455 (bütçe yükseltilmedi; `@file` indeks önbelleği → workspace-read, dosya etki kimliği → workspace-write;
  arch kenarları), `f73b3f25` i18n en/tr + katalog redaktör testi, belge commit'i. Ayrıntı ve açık maddeler PLAN "On ikinci parti".
- Doğrulama (tam verify değil): typecheck 0; `eslint .` 0 hata (5 uzunluk uyarısı, önceden var + şeritten `service-protocol.test.ts`); lint-arch 0 ihlal;
  lint-core-memory 0; `npm run build` ✓ (`bubblewrap=staged from .pack/bwrap/s6-check`); hedefli vitest (sqlite/ledger, secret, servis protokolü, terminal PTY,
  i18n, dist, MCP, shell overlay; VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı değişkeni) **151 dosya 972/972, 0 atlanan**; `~/.deckent` değişmedi;
  derlenmiş dist'ten üç yeni metin en/tr redaktörde değişmiyor; build-dist `--bwrap` + pack-smoke Node 24.15.0 (SQLite tam 3.51.3, taban kabul), 24.21.0 ve
  26.10.0 ✓. Kanıt `proof/INTEGRATE-M-2026-09-29/`.
- v18 (lead kararı: v17 push edildi → sürüm artışı): secret işlemleri yalnız v18'de, pencere [18,17] yaşam döngüsüyle sınırlı; commit aşağıda.
- Bilinen sınırlar: mevcut kurulumlarda secret grant'ı elle (§5; canlıda eklendi); v16 servisi canlı geçişte eski CLI ile durduruldu; Node 26 PTY
  kanıtı yalnız şeritte; eski SQLite'lı gerçek Node ile ret yalnız birim testinde (enjekte sürüm); `ci.yml` lead incelemesi bekliyor.

## On üçüncü parti (`integrate/2026-09-29-n`, worktree `/home/alperen/deckent-next-integrate-n`, taban main `0360bab9`)
- Birleşenler (`--no-ff`): REALM-NOTICE `5bd4a3dd`; LANG-CRASH `19d7caee` (`044f7b90` MCP managed-file tipli hata + `dfce9015` sistem istemi v5 yanıt dili,
  özet o dilde); OPEN-SANDBOX `bf21ec73` (`e376f546` + `46148e4f` + `cef933a7`: full-access açık bubblewrap görünümü, yapısal sert taban, owner Y).
  Şerit teslimleri bağımsız inceleme bekliyor.
- Entegrasyon: composition 5506 → 5423 (bütçe 5500 yükseltilmedi): ajan çalışma alanı/ürün durumu duruş türetimi bayt-özdeş
  `adapters/core/agent-workspace-floor`'a taşındı (arch kenarları); belge commit'i (OPEN-SANDBOX + LANG-CRASH deltaları, oturum 1d428e9f analizi PLAN'da).
- Doğrulama (tam verify değil): typecheck 0; değişen dosyalarda eslint 0 hata (1 önceden var uzunluk uyarısı, `runPeerConfiguredChatTurn`); lint-arch 0 ihlal;
  `npm run build` ✓; hedefli vitest (taşınan kod, open-sandbox, full-access, dil/MCP; VITEST_MAX_FORKS=2, FORCE_COLOR yok, Docker imajı değişkeni)
  19 dosya 163/163, 0 atlanan; `~/.deckent` ve `~/.local/state/deckent-next-dev` test sırasında değişmedi.
- Lead kararı (dil, 2026-09-30): B — canlı config `language: tr` bir sonraki canlı yeniden başlatmada; A — protokol v19 `chatTurn.language` bir sonraki
  protokol paketinde; yanıt dili son-kontrolü ayrı kart. Açık bulgu: `mcp add`/`remove` kayıt dosyasını denetimden önce yazıyor.

## Sıradaki
1. On yedinci parti (`integrate/2026-09-30-r`, yukarıda): tam verify → Sol REQUEST_REVIEW → PASS'te push → canlı geçiş; ardından DEV-U2-0 ilk geçişi. Sonra WORKER-CURRENCY-2
   artıkları (`models --help` satırı, terminal `/models`, sohbet yolunun ledger kataloğuna taşınması), K3 → K5/K6 → U2.
2. REALM-NOTICE açığı: MCP ön-başlatma launch kartı gerçek realm'i önceden adlandırmıyor — (a) `usable()` ön-seçimi / (b) olduğu gibi; lead/owner.
3. Owner kararları: SHELL-OVERLAY O1/O3/O5/O6/O7; `format` denetleyicisi, şema korpusu ölçümü, AppArmor kurulum belgesi, CI `bwrap-bundle.yml` ilk koşu;
   DEPS-SCHEMA C1 kanıtı; sabah listesi `proof/MORNING-REPORT-2026-09-29.md` (P1 tasarımları: OTel / uzak MCP, anahtar zinciri K2; zod 4 hata kodları;
   MCP sandbox seçenekleri B/C/D/E + tur başı `notice` olayı; DEPS-DIST yayın engelleri ve DEPS-DIST-B1; ANTHROPIC ilk faturalı duman çağrısı ve legacy
   tarifeler; fast-uri kabul edilmiş riski 2026-10-29); canlı secret deposunun env → dosya geçişi.
4. **Node 26 geçişi (owner, gözden kaçmasın):** Node 26 LTS 2026-10-28'de çıkınca kurulur → tam verify → nvm varsayılanı, CI zorunlu geçidi ve
   canlı servis Node 26; o güne kadar canlı Node 24.21 (PLAN "On ikinci parti").

## Açık kalanlar
- Oturum 1d428e9f açık P1'leri (PLAN "Owner terminal oturumu 1d428e9f"): `/policy` + `/permissions` (POLICY-ADMIN P5); ajan yönetim araçları (yetki isteği
  kartı, MCP durumu); terminal Agent OS komutları (O1) + UI/UX tasarımı; OPEN-SANDBOX-HIDDEN-PATHS takip kartı; MCP kayıt-önce-denetim sırası.
- Owner tasarım onayları (2026-09-29): soru kartları A, terminalden Agent OS O1, DECKENT.md Öneri 1 — uygulama dilimleri bu partiden sonra (owner: yeni iş yok).
- SHELL-AUTONOMY açık owner soruları: C1 program tabanı sandbox'ta, C2 audit event v2 (realm/hücre); `run_shell` model açıklaması sürümü
  (C3 → full-access, C4 → yazım duruşları ile kapandı).
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek; ret kodunda uç nokta/ledger ayrımı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
