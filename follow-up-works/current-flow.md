# Anlık iş akışı — A02, B08 ve B05 ilk dilimi teslim edildi; sıradaki iptal/faz düzeltmesi ve B06

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

## Sıradaki sıra

1. **EXECUTION düzeltmesi (owner onayı gerekir, sözleşme davranışı):** iptal edilen attempt'in `cancelled` fazına inmesi ve kapasiteyi
   bırakması; başlatma öncesi iptalde prevented→cancelled yolu; `PATCH_LIMIT`/`PATCH_UNAVAILABLE` ayrımı. B07 kurtarma kabulünün önkoşulu.
2. **B06** doğrulanmış benimseme/terfi + rollback: teslim edilen `refs/deckent/deliveries/…` commit'inin canlı checkout'a kontrollü alınması.
3. **B07** tekrarlanabilir dogfood kabulü; DOGFOOD OFF kalır. Sonra A03/A04/C10/C11/C12.

Kabul edilen plan değişmez: D15a Mission author D14 sonrası; D15b do D14'ten bağımsız. H34 company scope;
Core company/RBAC M2 öncesi, IdP/SIEM M4. Yeni yetki sınırı somut seçenekle ownera gelir.

## Ayrı sahipli Cursor hattı ve host araçları

Cursor localLLM/terminal: /home/alperen/deckent-next-wt-local-llm, feat/local-llm-terminal, başlangıç 652d1c2;
bu dilimde değiştirilmedi/merge edilmedi. Host guard ve Jev araçları önceki checkpoint'tedir; hook bağlama
`.claude/settings.local.json` içinde yerel ve gitignored'dır. Geliştirme kanıtı refactor-work altında, Git/npm dışında.
Legacy read-only, çalıştırılmaz.
