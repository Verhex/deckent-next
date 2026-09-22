# Anlık iş akışı — güncel PLAN / Jev kontrolü

Owner Fable planını iletti; belge düzeltmeleri ve tam commit/push sonrası sıralı uygulamaya devam
izni var. Bu checkpoint DOGFOOD açılışı değildir. Fable kanalı kapalı;
Grok/Jev danışması bağımsız ürün PASS'i veya owner kabulü değildir.

## Mevcut kod ve önceki gerçek kanıt

Baz HEAD 652d1c2; önceki onay commit'i dcab7e6. Dört dar dilim uygulandı: task-policy kaynaklı
onay bekleyeni kapasite öncesi dışlama; Linux süreç/socket bağlı canlı oturum; ayrı Git referansına
crash-recoverable teslim; üç native sağlayıcının gerçek paralel yerel çalışması. Kaynak HEAD/index/WIP
korunur. Genel approval/tool döngüsü, remote token verifier ve canlı branch merge tamam değil; DOGFOOD kapalıdır.
Önceki verify:1541 ürün/265 dosya,25 native,36 host; fail/skip0. Bu belge adımında yeniden worker koşulmadı.
Kanıt: /home/alperen/deckent-refactor-work/proof/FOUR-STEP-EXECUTION/{review.md,completion.json}.

## Bu belge teslimi

PLAN mevcut yetenek/O3/O4/O6/teslim/kanıt satırları kodla eşlendi; ARCHITECTURE eski provider/approval
anlık görüntüsünü güncel davranıştan ayırıyor. Mission hedefi kabul edilmiş, uygulaması bekliyor;
Jev'e otomatik taşınan north-star metni de bu kabul edilmiş kararla eşlendi. Mevcut PLAN WIP korundu.
Grok'un SDK-tek-socket ve PostgreSQL→SSO zorunlu sıralaması kabul edilmiş karar olarak alınmadı.
Handler'sız katalog metinleri ürün kabulü değil; locale silme/yüzey ekleme bu belge diliminde yapılmadı.
Analiz değerlendirmesi ve kanıt: /home/alperen/deckent-refactor-work/proof/DOC-RECONCILIATION-2026-09-22/review.md.

## Owner checkpoint ve sıradaki uygulama

Owner 2026-09-22 son düzeltmeleri kabul etti: D15a Mission AI author (D14 sonrası), D15b `do`
(D14'ten bağımsız); A02 ölçümü M1–M5 tarihlerine kaynak; H34 company scope, Core company/RBAC
M2 öncesi, IdP/SIEM M4. Process = operasyon kataloğu + business-operation + mevcut yürütme/Mission
şablonları; üçüncü motor yok. ARCHITECTURE ve talimat/north-star aynı kabul edilmiş hedefe eşlendi.

Önce bu main checkpoint'i tam verify → commit → push (owner açık izni); Cursor worktree’si dahil değil.
Ardından ilk uygulama: Fable'ın bildirdiği `--bare` uygunluğunu sabitlenmiş imajda kendi kanıtımızla
kontrol et; ambient keşif, abonelik auth ve explicit settings davranışını ayır. Sessiz API/ücret geçişi yok.
Sonraki bağımsız hazırlık A02 ve N/N+1 kabul/kurtarma; Cursor localLLM/terminal sahipliği korunur.
Yeni yetki sınırları somut seçenekle ownera gelir; mevcut worker izinleri tekrar sorulmaz.
İş listesi ve taze PLAN snapshot/hash: /home/alperen/deckent-refactor-work/proof/PLAN-CHECKPOINT-2026-09-22/.
DOGFOOD_MODE=OFF; geniş tier/ortak dosya değişiklikleri Cursor ile birleşme sınırında sıralıdır.

## Host guardrail dilimi — 2026-09-22 (Fable, owner talimatı)

Jev 2be86b6c: local_only_guardrails 0,73 / committed 0,20 / none 0,04 / insufficient 0,02; sufficiency 0,79.
Yapılan: `.agents/refactor/host-guard.mjs` + `host-guard.test.mjs` (8 test, `npm run test:host` kapsamında);
`.claude/settings.local.json` (gitignored) PreToolUse/PostToolUse/SessionStart + allow/ask/deny kuralları.
Kanıt: canlı PreToolUse reddi (legacy dizininde node çalıştırma denemesi); ilk sürümde echo içindeki legacy
yolu yanlış engellendi, segment tabanlı analizle düzeltildi ve teste eklendi. Repoya hook/.mcp.json konmadı;
izli worker yolu dosyaları değişmedi. PLAN'a sağlayıcı bulguları aciliyet tablosuyla eklendi (owner talimatı).
Owner 2026-09-22: worker'lar varsayılan `--bare`, profil bazında istisna; PLAN satırına işlendi.
Açık: Codex/Cursor hook bağlanması, `--bare`/`--settings` profil alanı ve preflight doğrulaması (ISOLATION kartı), plugin eval.


## Aktif paralel hat — Cursor local LLM / terminal

Owner bu hattı Cursor’a verdi. Worktree `/home/alperen/deckent-next-wt-local-llm`, branch
`feat/local-llm-terminal`, başlangıç652d1c2; git worktree list ile doğrulandı. Astra aynı kapsamda
kod yazmaz, Cursor worktree’sini değiştirmez. Main’de belge eşleme ve owner’ın getireceği Fable planı
üzerinden koordinasyon sürer. Main’deki commitlenmemiş güncel talimatlar eski worktree’ye otomatik geçmez.
Cursor raporu: /home/alperen/deckent-refactor-work/proof/LOCAL-LLM-INFERENCE/00-current-state.md.
GPU/toolkit ve tek-worker teşhisi bu oturumda yeniden ölçülmedi; slot eksikliği hipotezi henüz kesin
kök neden değildir. Legacy çalıştırılmaz; ölçüm Next veya izole test harness’ında yapılır.
Sonraki entegrasyon: Cursor exact commit/diff ve gerçek paralel koşum/terminal kanıtı sunar; güncel
main kararlarıyla eşlenir, ortak kaynak/conflict ve custody incelenir, birleşen sonuç verify edilir.
Şimdi merge/commit/push veya host kurulum yapılmadı; DOGFOOD_MODE=OFF.
