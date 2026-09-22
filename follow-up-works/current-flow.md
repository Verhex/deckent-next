# Anlık iş akışı — Opus 5.5 devraldı; E24 Cursor Paket A (yerel çıkarım + Ink terminal) main'e alınıyor

## Geçici yürütücü devri — owner 2026-09-22

Owner limit yenilenene kadar kabul edilmiş 40 ana maddenin rutin yürütücüsü Fable'dır.
[Devir paketi](../../deckent-refactor-work/FABLE-CONTINUATION-2026-09-22.md) okundu ve devralındı;
eski communication.md açılmadı, uzun goal yok. Owner isteğiyle devir belgeleri f2bdecb olarak
commit'lendi ve `origin/main`'e push edildi (0 geride / 0 ileride). Cursor E24/F26 hattı ayrı kaldı.

## Son teslim: A02/W0-3 süre/bekleme/doğrulama/rework enstrümanı

`node .agents/refactor/effort.mjs start|phase|pause|end|status|report` dilim başına M1–M5, kart,
startedAt/endedAt ve açık `active|blocked|verification|rework` aralıklarını `.deckent/host/effort/<dilim>/`
altında immutable, özel (0700/0600) sıralı olay dosyalarına yazar; jev-journal'ın exclusive-link
mekanizması yeniden kullanıldı (journal helper'a yalnız anahtarsız çağrı izni ve `instant` export'u eklendi).
Süre yalnız açık olaylar arasında sayılır; `pause` ve açık kuyruk *unknown* kalır, hiçbir eşikle
tahmin edilmez; uzun aralıklar yalnız işaretlenir. Durum enum: `started|active|blocked|verification|rework|paused|done|canceled|handed-off`;
blocked nedeni zorunlu enum. `--at` zaman damgası operator-supplied olarak ayrı sayılır; gelecek/monoton-olmayan
zaman, bitmiş dilime olay, çift pause, sıra boşluğu ve private-key içeriği reddedilir. Rapor kilometre taşı
başına gözlenen/unknown süre verir; commit sayısı hiçbir yerde efor değildir. Kart dosyaları yeniden yazılmadı;
verify-context/reporter değişmedi. 6 node:test vakası (`test:host` 50).

**İlk gerçek kayıt (bu dilim, M1):** başlangıç 11:29:06+03:00 (oturum dizini mtime, operator-supplied; öncesi
gözlenmedi), bitiş 11:48:33+03:00. Gözlenen: active 0,13 s, verification 0,19 s, rework 0,003 s (eslint
`preserve-caught-error` düzeltmesi), blocked 0, unknown 0. Doğrulama aralığında belge düzenlemesi de yapıldı;
enstrüman aynı anda tek tür sayar. Tek dilim tahmin güncellemez; PLAN M1–M5 tablosu iki haftada bir
`effort report` ile yeniden yayımlanır.

**Doğrulama:** üç tam verify koşumu. 1) eslint `preserve-caught-error` ile durdu (rework kaydı). 2) `DECKENT_TEST_DOCKER_IMAGE`
tanımsızken 12 kurulum/servis testi ortam nedeniyle başarısız, 87 skip — enstrüman kusuru değil. 3) Astra'nın
kullandığı `node:24-trixie-slim` imaj ID'siyle: **1556 ürün/265 dosya, 25 native, 50 host; fail/skip 0**; lint/build/smoke geçti.
Kanıt: `/home/alperen/deckent-refactor-work/proof/A02-DURATION-INSTRUMENT-2026-09-22/` (üç verify logu, Jev vakası/yanıtı, review.md).
Jev 40a55451 özel journal + açık pause seçeneğini %99 önerdi; none 0, insufficient %1; karar ve verified outcome kayıtlı.
Bağımsız inceleme yok; Jev/kendi doğrulama Fable PASS değildir. Yerel commit e9572fe; push için owner sözü gerekir.

## İkinci teslim: sürümlü `deckent/worker` imajı (owner mid-turn isteği, B08)

Owner isteği: Deckent Docker imajı oluşturulsun, sürümleme imajın içinde yorum satırlarıyla takip edilsin,
eski sürümler arşivlensin. Uygulama: `recipe.json` schema 2 (`repository deckent/worker`, `imageVersion r2-20260922`,
`previousVersion r1-20260921`); Dockerfile başında en yeniden eskiye `# version <id> | <tarih> | base <imaj> | supersedes <id|none> | <neden>`
tarihçesi, `history.mjs` ile recipe'ye karşı doğrulanır ve imajın içine kopyalanır; OCI label'ları build-arg'dan;
`build.mjs` dolu sürüm etiketini derlemeden önce `WORKER_VERSION_TAKEN` ile reddeder, derlenen ID'yi
`deckent/worker:<sürüm>` etiketler, schema-2 receipt'e sürüm/etiket/label/tarihçe/kaynak hash/probe manifestini yazar;
hiçbir şey imaj/etiket/receipt silmez. Eski ae5301… imajı receipt'inden geriye dönük `deckent/worker:r1-20260921`
etiketlendi, receipt'i `worker-images/archive/r1-20260921.json` olarak arşivlendi (kaynağı doğrulanmamış notu korunur).

**Derleme:** r2-20260922 = `sha256:adfcbe4c56c886d6c97ab6f7fecbf62d70df8c4463e3f4d3394558ebad0c4894`, 910 MB;
codex-cli 0.155.1, claude 2.1.278, cursor 2026.09.18 zorunlu bayraklarla; imaj içinde 2 `# version` satırı ve r2 recipe doğrulandı.
Negatif: aynı sürümü yeniden derleme derleme başlamadan reddedildi, receipt yazılmadı. `--image-id` re-probe yolu
kaynak-doğrulanmamış receipt üretti, yeniden etiketlemedi. Tam verify: **1556 ürün/265 dosya, 25 native, 53 host; fail/skip 0**.
Kanıt: `/home/alperen/deckent-refactor-work/proof/B08-WORKER-IMAGE-R2-2026-09-22/` (build.log, receipt'ler, negatif log, verify, review.md).
Jev 55ee642a %96 (none %1, insufficient %2); karar/outcome kayıtlı. Ürün bağlaması imageId; tag/label yetki değildir.

**r2 ile gerçek koşum (owner isteği):** Astra'nın doğrulanmış kompozisyon betiği r2 receipt'ine bağlanarak (`live-r2.mjs`)
claude → cursor → codex sırayla koştu: üçü de exit 0, note.txt tam eşleşti, tek-dosya patch ve prompt receipt hash'leri eşleşti,
network none / kapalı mount / salt okunur kök korundu, replay terminal; kaynak HEAD/index/WIP ve host credential dosyaları değişmedi;
r2 konteyneri kalmadı. Kanıt: `r2-live.json`, `live-r2.log`. Bu abonelik kotasıyla tek sıralı koşumdur; genel dogfood kabulü değildir.
Açık: execution profilleri hâlâ r1 imageId'sini gösterir (yeni profil revizyonu ayrı küçük dilim); provider kanalları `latest`.

**Dangling imaj envanteri (salt okunur, 16 adet):** 13'ü legacy `Dockerfile.worker` derlemeleri (2026-08-21…09-04; CLAUDE_CODE_VERSION 2.1.259,
INSTALL_CODEX/CURSOR/GEMINI/OLLAMA build-arg'ları, `/app/dist` + exec-authority native, HEALTHCHECK `claude --version`), 1'i legacy runtime tabanı
(09-04, 125 MB), 1'i eski llama.cpp CUDA katmanı (08-13, 2,6 GB; Cursor hattının güncel imajı ayrı), 1'i Astra'nın r1'den 3 dk önceki
ilk Next derlemesi (aa3506…, 09-21 14:47, 910 MB). Hiçbirinin receipt'i/etiketi yok; Next ürünü bunları bağlamaz. Astra'nın bu imajlar
için yazılı bir planı bulunamadı (PLAN yalnız "eski imajlar korunur" der). Owner kararı: şimdilik kalsın; silme owner'ın komutudur.
`/tmp/dn-prompt-*` altında 3 küçük fixture dizini (2 Astra, 1 bu koşum) duruyor.

**Ölçüm (effort report):** A02 M1 done active 0,13 s / verify 0,19 s; B08 M2 done active 0,12 s / verify 0,12 s; B08 canlı koşum M2 done active 0,01 s / verify 0,02 s; B05 M2 done active 0,10 s / verify 0,37 s (döngü içi rework verify altında sayıldı); unknown 0.
A02 kapanışı ile B08 açılışı arasındaki ~10 dk (commit + ilk inceleme) dilim dışı, kayıtsız.

## Üçüncü teslim: B05 — kararlı N, izole N+1'i yönetti

Paketlenmiş N (`npm pack` e1f1a4d → `/home/alperen/deckent-n/prefix`, symlink bin `--version` çalıştı; global-home ve data kökleri N altında)
ayrı N+1 klonuna (`/home/alperen/deckent-n1`, e1f1a4d) kurulum uyguladı (operator-custom, r2 imajı, `dogfood` scope, 3/3 havuz).
N'in paketlenmiş servisi (cmdline N bin, cwd N+1) gerçek Claude worker'ıyla `coding-7` görevini kabul etti (yeni test vakası eklendi),
patch → aday → **reference-only teslim** `refs/deckent/deliveries/ffc729af…` (commit 58c62107, parent = base); teslim edilen commit
worker dışında `node --test` ile 4/4 geçti. `hold-7` başlatıldıktan sonra iptal edildi (konteyner 137, teslim terminal). Servis SIGKILL →
yeniden başlatma → coding kabulü korundu, `echo-7` kabul edildi. N+1 HEAD/index/WIP ve canlı checkout değişmedi; N paket/global-home/data,
N+1 ve canlı checkout ayrık. Kanıt: `/home/alperen/deckent-refactor-work/proof/B05-N-NPLUS1-2026-09-22/` (n1-live.json, live-n1.log, review.md,
run1–5 kayıtları, diag-patch.mjs). Jev 7f268e20 %99; karar/outcome kayıtlı. Ürün kodu değişmedi; bağımsız inceleme yok; DOGFOOD OFF.

**Bulgular (PLAN'a yazıldı):** (1) başlatma öncesi iptal görevi `active+cancelRequested` bırakıyor, reconcile/execute kapatamıyor;
(2) başlatma sonrası iptal `evaluating`'de kalıyor, `TASK_EVALUATION_NOT_READY`; ikisi de havuz slotunu tutuyor (2/2 havuzda yeni Run
rezerve olmadı); (3) patch hazırlığı tüm ağacı okuyor, 64 KiB `git.outputBytes` Deckent ağacında `PATCH_UNAVAILABLE` verdi; 4 MiB/180 s/32 MiB ile geçti.
Kendi hatam: teslimden önce konteyneri serbest bırakmak patch custody'sini yok etti (tasarım gereği); sıra düzeltildi.
Eski data/data2 kökleri ve `data2`'deki diag konteyneri (kaldırıldı) kanıt olarak duruyor; silme owner'ın.

## Dördüncü iş: bulguların derin araştırması (owner: bulgular kesinleşmeden sıradaki adım kapalı)

Kod düzeyinde kök nedenler bulundu (progression iptal istenen Run'ı atlıyor; teslim işçisi dispatch'siz attempt'e dokunmuyor; sandbox
portu yalnız `exited|unknown`; değerlendirme iptal istenen Run'ı reddediyor; `preventRunAttempt` yalnız başlatma kararında; patch
snapshot dosya başına `cat-file` + catch-all `PATCH_UNAVAILABLE`). Legacy salt okunur: CANCELLED fold + cancelReason + stale-run sweep.
Vendor dokümanları (context7/web): Claude Code `claude update`/`DISABLE_AUTOUPDATER`/`claude doctor`; Codex `codex update`/`check_for_update_on_startup`;
Cursor `agent update` (auto-update varsayılan açık, kapatma belgelenmemiş); OpenHands `uv tool upgrade openhands`; Hermes `hermes update [--check]`.
Üç Jev danışması, kararlar kayıtlı: iptal settlement 1,00 (aa51432f); patch tipli limit + hash-diff 0,98 (d1247cf4); doctor güncellik +
politika güdümlü sürümlü rebuild 0,97 (64811c47; vendor_mechanisms 0,46 — Cursor kapatması doğrulanmalı). Ürün kodu değişmedi.
Rapor: `/home/alperen/deckent-refactor-work/proof/FINDINGS-RESEARCH-2026-09-22/review.md`. Uygulama owner onayı bekler.

## Beşinci teslim: iptal settlement (bulgu 1+2 düzeltmesi, owner "devam" 2026-09-22)

Ürün kodu (8b96d5d): domain `settleCancelledRunAttempt`; `cancelRun` transaction'ında başlatılmamış bağlı attempt'ler `preventRunAttempt`
ile, iptal öncesi çıkmış-değerlendirilmemişler settlement ile `cancelled`; iptal istenen worker'ın kaydedilen çıkışı `finishDispatch`
projeksiyonunda aynı transaction'da `cancelled`; `reconcileAttempt` ve teslim işçisi idempotent `settleCancelledAttempt` uygular ve
`settlement` raporlar; RunView türetilmiş iptal nedeni (`prevented-before-launch|exited-under-cancellation`). Gözlem uydurulmaz,
launch/retry yok, accepted/failed dokunulmaz, unknown/unresolved reconciler'da kalır. Ledger şeması değişmedi.
Testler: domain settle (3), store settlement (3: başlatma-öncesi + kapasite, öldürme-sonrası, iptal-öncesi-çıkış); eski `active`
beklentileri güncellendi; migration seed'i şema-11 şekline (dispatch claim) alındı, validator gevşetilmedi.
**Tam verify: 1562 ürün/267 dosya, 25 native, 53 host; fail/skip 0.** Tekrar kanıtı: 8b96d5d'den paketlenen N (`prefix2`, `data4`,
1 slotlu havuz) `hold-8`'i teslimden hemen sonra `cancelled` yaptı, yeniden başlatma sonrası `echo-8` serbest kalan tek slotla kabul edildi,
N+1/canlı checkout değişmedi. Kanıt: `proof/B05-N-NPLUS1-2026-09-22/{live-n1-fixed.log,n1-live-fixed.json,review.md}`. Jev aa51432f 1,00.
Açık: iptal istenen Run'ın hâlâ `pending` görevlerinin run düzeyinde kapanışı (ayrı geçiş); patch limit/hash-diff (bulgu 3) ve toolchain
güncelliği sıradaki dilimler.

## Altıncı teslim: patch tipli limitler + hash-diff (bulgu 3)

Ürün kodu: `git-patch/snapshot.ts` baz ağacını tek `ls-tree` ile listeler (yol/mod/oid/boyut, içerik okumaz), workspace'i fd-relatif
okuyup Git blob id'siyle (`blob <size>\0` + depo algoritması sha1/sha256) karşılaştırır; yalnız değişen/eklenen/silinen yollar için
sınırlı `cat-file`. `integration-target.ts` aday hazırlama/doğrulamada `before` girdilerini baz oid'leriyle doğrular ve adayın
baz + patch olduğunu aynı hash-diff ile kanıtlar (Git içerik okuması yok; manifest digest'i adayın tam okumasını kapsamaya devam eder).
Git çıktı/süre aşımı ve tarama bütçeleri tipli `PATCH_LIMIT` + sınırlı `detail` (`git-output|git-timeout|time|bytes|entries|depth|path`),
error params ile yüzeye çıkar; `PATCH_UNAVAILABLE` yalnız custody/Git yokluğu. `execution.git.outputBytes` varsayılanı 4 MiB.
Testler: 1500 dosyalık depo (64 KiB sınırında `PATCH_LIMIT/git-output`; yalnız 2 değişen blob okunur), Docker workspace-patch süiti 23/23.
**Tam verify: 1565 ürün/268 dosya, 25 native, 53 host; fail/skip 0** (bir önceki koşumda README'yi suite sırasında düzenlemem paket
ölçümünü bozdu; suite sırasında paketlenen dosya düzenlenmez). Jev d1247cf4 %98; outcome verified kaydı.
Not: `cat-file --batch` yerine değişen blob başına tek `cat-file` seçildi; ölçek yine O(değişen).

## Yedinci teslim: toolchain güncellik raporu (owner 2026-09-22, Jev 1990f990 1,00)

Sürümlü mekanizma kataloğu (Codex/Claude npm paketi + self-update kapatma anahtarı; Cursor installer-script, güncellik `unsupported`),
engine saf karşılaştırma/rapor sözleşmesi (`fresh|stale|ahead|unparsed|unknown-offline|unsupported|disabled|not-admitted`),
`npm-registry` adapter'ı (sınırlı GET `<endpoint>/<paket>/latest`, kimlik yok, timeout/boyut sınırı, tipli hatalar),
`toolchains.currency` config verisi (`mode off|report`, `registryEndpoint`, `timeoutMs`, `responseMaxBytes`),
composition `inspectConfiguredToolchainCurrency` (kabul edilen sürümler = admission registry'deki native profillerin preflight pin'leri),
CLI `doctor --toolchains` (yalnız bayrakla; varsayılan doctor ağ kullanmaz), MCP `inspect_toolchain_currency`, SDK `inspectToolchainCurrency`.
Testler: engine 4, adapter 2 (yerel HTTP fixture: durum/boyut/geçersiz/timeout/erişilemez), composition+CLI 3 (fixture registry,
çevrimdışı, `--toolchains` opt-in ve kullanım hataları). `cli.help` şablon değişikliği i18n oracle'ında (`cli-text-changes.json`) beyan edildi.
**Tam verify: 1574 ürün/271 dosya, 25 native, 53 host; fail/skip 0.** Gerçek koşum (N+1 kurulumu, `registry.npmjs.org`): claude `fresh`
(2.1.278 = en yeni), codex/cursor `not-admitted` (o kurulumda yalnız Claude profili). Kanıt: `proof/B08-TOOLCHAIN-CURRENCY-2026-09-22/`.
Jev 1990f990 1,00; outcome verified. Açık: Cursor kapatma yolu doğrulanmadı (`unsupported` veriyle); npm `latest` GitHub sürümünden geride kalabilir.

## Sekizinci teslim: politika güdümlü sürümlü rebuild (owner 2026-09-22, Jev 450cc23b 1,00)

`toolchains.update {mode off|propose|auto (varsayılan propose), buildTimeoutMs, outputBytes, atStartup}`. Engine: `planToolchainUpdate`
(stale npm sağlayıcı yoksa `no-change`; varsa tek sonraki sürüm `r<N+1>-<gün>`, tarihçe satırı, recipe deltası, etkilenen native profiller),
`proposeProfileRevisions` (receipt'ten tam `cliVersion`/`imageId` değişiklikleri, `not-applied`). Adapter `worker-image`: paketteki builder
dosyalarını özel/exclusive bağlama kopyalar, düzenlenmiş Dockerfile/recipe yazar, `build.mjs`'i sınırlı process runner'la (env allowlist,
timeout, çıktı sınırı) koşturur; tek başarı kanıtı receipt dosyası. Composition `updateConfiguredToolchains`; CLI `toolchains update [--apply]`;
MCP `update_toolchains`; SDK `updateToolchains`; `runtime serve` `atStartup` ile yalnız rapor yayar. Kurulu config/policy/paket baytları
değişmez; artefaktlar `<workspaces>/toolchains/{plans,builds,receipts,proposals}` altında (yeni layout kaynağı eklenmedi: layout revizyonu
attempt kimliğinin hash'i). Codex komut kataloğuna `-c check_for_update_on_startup=false` eklendi (yeni profiller). Testler: engine 3,
adapter 2 (gerçek assets'ten bağlam, enjekte runner, env allowlist, hata eşlemeleri), composition/CLI 2 (off/propose/apply/auto/no-change,
aynı gün ikinci apply `WORKER_IMAGE_CONTEXT_EXISTS`, config'in yazılmadığı). MCP parite testine `update_toolchains` (readOnly false, openWorld true) eklendi.
**Gerçek `auto` koşumu:** eski Codex pin'li (`codex-cli 0.150.0`) geçici proje → gerçek registry → plan `r3-20260922` → gerçek `docker build`
(95 sn) → receipt `deckent/worker:r3-20260922` (`sha256:4b2065ea…`; codex-cli 0.155.1 / claude 2.1.278 / cursor 2026.09.18; tarihçe r3→r2→r1) →
`not-applied` profil revizyon önerisi (codex-stale: 0.150.0 → 0.155.1, imageId r2 → r3). Docker'da r1/r2/r3 üçü de duruyor.
Kanıt: `proof/B08-TOOLCHAIN-UPDATE-2026-09-22/`. Jev 450cc23b 1,00; outcome verified.
**Tam verify: 1581 ürün/274 dosya, 25 native, 53 host; fail/skip 0** (temiz koşum). Önceki koşumlarda üç aralıklı, yük-bağımlı hata görüldü ve
izole geçti: `openrouter-priced-invocation` (`STALE_TARIFF` zaman penceresi), `model-invocation-spending-native` (`unknown` sonuç),
ilk koşumda eşzamanlı docker build yükü. I40 triyajı için not: bu iki test zaman penceresine duyarlı; kök neden ölçülmedi.
Düzeltilen gerçek kusur: `runtime serve` açılış raporu host `done` handler'ını geciktiriyordu (unhandled rejection) — yarış önce kurulup
işlenmiş işaretleniyor. Açık: receipt `sourceRevision` kopyalanan bağlamda `unknown`; öneri uygulama otomasyonu ayrı dilim.

## Devir — Opus 5.5 (owner 2026-09-22, devralındı)

Opus [devir paketini](../../deckent-refactor-work/OPUS-CONTINUATION-2026-09-22.md) devraldı; main = origin/main = f9f1926, ağaç temiz.
Temizlik silmeleri (refactor-work arşivli 13 belge, Go toolchain, eski `/tmp/deckent-*`/`/tmp/dn-*` test artıkları, çıkmış test
konteynerleri, yetim `node -e setInterval` test süreci) owner'a bırakıldı ("sonra ben yaparım"). Test artığı sızıntısı ayrı bulgudur.

## E24 teslim: Cursor Paket A main'e alma (owner 1-a, ink/react kabul, host betikleri Opus kararı)

Cursor durdu; commit'lenmemiş WIP `1da40c8` olarak (geçici index, worktree dokunulmadan) alındı, `integrate/terminal-package-a`
(`/home/alperen/deckent-next-wt-terminal-merge`) dalında main üzerine uygulandı; 3 çakışma (current-flow main, cli.help en/tr +2 satır).
Baseline commit c220673; düzeltmeler ayrı commit. Jev c8f5bb72: integrator_fixes_then_land 0,88 (none 0,03, insufficient 0,04); karar kayıtlı.

**Bulunan ve düzeltilen kusurlar (inceleme Opus alt ajanı = self-review, bağımsız değil):** (1) `terminal` config bölümü kayıtlı değildi,
`terminal.chat` yükleyicide `unrecognized_keys` ile reddediliyordu — yönetilen sohbet hiç yapılandırılamıyordu; (2) istek gövdesi
`max_tokens`+`max_completion_tokens` taşıyordu, OpenAI ve OpenRouter adaptör şemaları reddederdi; (3) handler yoksa yüzey denetimsiz HTTP'ye
düşüyordu, engine `fetch` + `process.env` anahtar okuyordu; (4) scope çıkarım profilinden geliyordu, `--scope`/principal yoktu;
(5) `inference_serving` varsa tüm Run'ların slotu yerel LLM kapasitesiyle kısılıyor, token filtresi bekleyenleri biriktirmiyordu;
(6) Ink `Static` 400 kırpmasından sonra yeni satır basmıyordu; (7) tur iptal edilemiyordu, Ctrl+C busy'de yutuluyordu; (8) izleme sorguları
üst üste biniyordu, hatalar yutuluyordu; (9) `NO_COLOR`'da çerçeve rengi sabitti, TTY yalnız stdin'den; (10) köprü dosyası: env yolu,
tahmin edilebilir tmp, her render'da yazım, sohbet içeriği saklama/purge dışında; (11) `inference serve` yüzeyden süreç, `metrics`
yüzeyden HTTP; vLLM `0.0.0.0` publish; ürün metinleri host betiklerine atıf yapıyordu.

**Sonuç davranış:** her sohbet turu `models invoke` ile aynı runtime client'tan geçen tek yönetilen model çağrısı (`--scope`, taze katalog
binding, principal/policy/aktivasyon/harcama runtime'da); Esc/Ctrl+C(busy) → bekleme durur + o çağrı için iptal isteği; `workline` TTY
stdin+stdout ister (`TERMINAL_TTY_REQUIRED`), `session` pipe'ta satır modu; ledger ekleme-yalnız epoch'lu `Static`; tek-uçuşlu izleme,
sınırlı hafıza; `inference plan|budget` saf tahmin, loopback publish; Run kabulü main ile aynı; köprü snapshot'ı sohbet metni taşımaz.
Host betikleri `/home/alperen/deckent-refactor-work/host-tools/inference/` altına taşındı (Cursor akış notu dahil). Ink 7.1.1 / React 19.3.0 tam sabit.

**Kanıt:** yeni testler — composition terminal-chat 6 (gerçek config yükleyici; config→chat-plan entegrasyonu; OpenAI adaptör şeması pozitif +
eski gövde negatif; iptal hedef digest), Ink render 6 (600 satır, Esc/Ctrl+C iptal, idle Ctrl+C çıkış, renk yok, tek-uçuş/tek hata bildirimi),
CLI 5, **gerçek PTY süreç testi 3** (python3 `pty`: workline render, `/workers` → `POLICY_UNAVAILABLE`, sohbet → `TERMINAL_CHAT_NOT_CONFIGURED`,
idle Ctrl+C, pipe degrade), **uçtan uca 1** (derlenmiş `terminal session` → gerçek runtime servisi → fiyatlı fixture sağlayıcı: 2 tur 2 istek,
policy kapatılınca tipli hata ve 0 ek istek). Tam verify koşumu 1: 1617/1618 — tek hata `model-invocation.test.ts` (dokunulmadı, izole 3/3
geçti); koşum 2 (commit fe59762): 1617/1619 — `installed-runtime-service` (MCP execute_task, yeni imza) + `model-invocation-spending-native`
(`STALE_TARIFF`), ikisi izole 2/2 geçti, ilgili modüllerde diff yok; **koşum 3 (fe59762): 1619 ürün/285 dosya, 25 native, 53 host; fail/skip 0,
smoke geçti.** Üç koşumdaki farklı hatalar runtime/model-invocation ailesinde, yük bağımlı (I40); yeni PTY/uçtan uca testler süite yük ekler.
Kanıt: `/home/alperen/deckent-refactor-work/proof/E24-TERMINAL-PACKAGE-A-2026-09-22/` (üç verify logu, Jev vakası/yanıtı/kararı).

**Açık / owner kararı:** fiyatsız OpenAI uyumlu profil yönetilen yolda `PROVIDER_SPEND_UNAVAILABLE` ile reddedilir; yerel ücretsiz LLM ile
terminal sohbeti bu yüzden bugün çalışmaz (harcama politikası kararı: açık sıfır tarife / yerel sağlayıcı sınıfı). Cursor'ın çalışan
`deckent-qwen38-llama` konteyneri `0.0.0.0:18080` ile yerel ağa açık (kimlik doğrulamasız). Paket B: runtime olay aboneliği, Desktop köprüsü,
sunucu başlatma/metrics adapter'ı, görev→yerel-LLM bağlama ve kapasite kabulü, tam token pipeline.

## Sıradaki sıra

E24: owner onayıyla main'e commit (push ayrı söz); Cursor Paket B'ye yeni main üzerinden başlar (worktree'deki eski WIP yeni main'e
rebase edilmeli, çakışma beklenir). Sonra iş planı: öneri uygulama otomasyonu (profil revizyonu), API şema anlık görüntüleri, run düzeyi
kapanış, test artığı/yetim süreç sızıntısı triyajı, **B06/B07**; DOGFOOD OFF kalır.

Kabul edilen plan değişmez: D15a Mission author D14 sonrası; D15b do D14'ten bağımsız. H34 company scope;
Core company/RBAC M2 öncesi, IdP/SIEM M4. Yeni yetki sınırı somut seçenekle ownera gelir.

## Ayrı sahipli Cursor hattı ve host araçları

Cursor localLLM/terminal: /home/alperen/deckent-next-wt-local-llm, feat/local-llm-terminal (worktree dokunulmadı; Paket A içeriği
`integrate/terminal-package-a` üzerinden main'e gider). Host guard ve Jev araçları önceki checkpoint'tedir; hook bağlama
`.claude/settings.local.json` içinde yerel ve gitignored'dır. Geliştirme kanıtı refactor-work altında, Git/npm dışında.
Legacy read-only, çalıştırılmaz.
