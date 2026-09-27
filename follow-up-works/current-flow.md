# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-27 öğleden sonra, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde (`b596eee` ve öncesi), kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `b596eee` (Astra 2131 PASS, tam verify 4 çalışan). Canlı servis `b4e77dc` build'iyle çalışıyor (ledger v40, protokol v14).
  Kabuk/düzenleme izni için owner betiği `grant-edit-shell.mjs` henüz çalıştırılmadı. DOGFOOD OFF.
- Entegrasyon `integrate/2026-09-27` (worktree `/home/alperen/deckent-next-integrate`) üçüncü parti: H34 S3, H34 S4 (config 3 / layout 3 /
  doctor 2), A04-2, C12 G3, roller `task` kuralı, audit portu (ledger v41), I40-c B, kurulum çıkış 78, TERM-INTERACTIVE (slash Enter,
  `@file`, **protokol v15**), dilim 4a izin modları. Belge deltaları uygulandı (ARCHITECTURE/PLAN/CHANGELOG/COMPLETED-PLAN).
- Astra 2132 → 2133 ANALYSIS + 2134 REVISE (R1 P1 bileşik dar komutla yazma tabanı aşımı, R2 P2 audit edilen kararla kabul eşleşmesi,
  R3 P2 `@file` seçilen yol kimliği): düzeltmeler FIX-2133 (`e047075`) ve FIX-2134-R3 (`5538033`) partiye birleşti; kanıt `.deckent/host/reviews/astra-2132/`.
- Sıradaki: tam verify (4 çalışan) → Astra yeniden inceleme → PASS'te yalnız incelenen sha push (owner 2026-09-27 izni).
  Canlı yeniden başlatma (ledger v40 → v41 yedekli, protokol v15) owner iznindedir.
- Dördüncü parti dalı `integrate/2026-09-27-d` (worktree `/home/alperen/deckent-next-integrate-d`): C12 G4 + kalıcı cleanup işareti birleşti; SLICE4C şeridi çalışıyor.

## Şeritler (kartlar `deckent-refactor-work/cards/lanes/NEXT-2026-09-27-C.md`)
- V15-G4 ve CLEANUP-MARK teslim edildi, dördüncü parti dalında. SLICE4C (Opus, mod durum satırı + `/mode`) çalışıyor.
- B06-2 tasarımı (Fable) teslim: `proof/B06-2-DESIGN-2026-09-27/design-note.md`; öneri A (mevcut Run + Docker sandbox, Run teslim commit'ine
  sabitlenir, benimseme açık `verificationRunId` ile bağlanır, ledger v42). Owner soruları S1 (A/B), S2 (v42), S3 (sandbox bağımlılıkları).

## Owner kararı bekleyenler
- B06-2 S1–S3 (+ S4–S9 ayrıntı), `@file` için ayrı politika izni, dilim 4a açıkları (full-auto'da salt-okunur kabuk → audit olay v2; `rm`),
  S3 açıkları (`runtime serve` yabancı pinli kendi kapsamında başlangıç reddi; run-progression yoklaması), A04-2 config girdilerinin overlay
  ad alanında kalması, G3 süreçler arası tek kullanım ledger seçeneği, `lane/l5-i40` (birleşmemiş tanı testi).
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md`.

## Açık sınırlar (ARCHITECTURE'da)
- Karışık sürüm: dilim 4a alanlarını (`modeEligible`, bindings v2) taşıyan belge eski build'de bütünüyle reddedilir (fail-closed).
- Dilim 4a: hiç onay üretmemiş kurulumda ilk sessiz çağrı onay/audit bütünlük anahtarını oluşturur (sayaç yolu).
- I40-c B: eski build yeni `agent-tool-call` kaydını `APPROVAL_INTEGRITY` ile reddeder; v41 karışık okumayı önler.
- Kabuk sandbox değil; servis çökerse çalışan komut sahipsiz kalır.
