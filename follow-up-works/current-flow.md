# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-27 akşam, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `900f97d` (üçüncü parti `357aeeb` Astra 2136 PASS, dördüncü parti `900f97d` Astra 2141 PASS; tam verify 374/2468).
- Canlı servis `900f97d` build'iyle (instance `fb3091bf…`), ledger v41 (yedek `backups/ledger-v40-2026-09-27T19-07-25-142Z.db`), protokol v15,
  config şeması 3, doctor JSON 2. Canlı policy v1 → izin modları ve `/mode` etkin değil (herkes `ask`). Owner betiği `grant-edit-shell.mjs`
  henüz çalıştırılmadı. DOGFOOD OFF.
- Yerel main checkout `900f97d`'ye ileri sarıldı. Astra'nın main'deki commit'lenmemiş inceleme notları (2135/2140 sınırları) yama
  `.deckent/host/reviews/astra-main-notes-2026-09-27.patch` + stash `astra-main-notes-2026-09-27` olarak saklandı; içerik PLAN/COMPLETED-PLAN'a işlendi.
- Ana checkout'tan çalışan iki host MCP süreci (`next-entry.mjs mcp`) eski kodla bellekte çalışıyor; sorun çıkarsa host oturumunun MCP'si yeniden başlatılır.
- Sonraki parti dalı `integrate/2026-09-27-d` (worktree `/home/alperen/deckent-next-integrate-d`), `900f97d` + belge commit'leri.

## Sonraki parti (`integrate/2026-09-27-d`, tam verify ve Astra incelemesi sırada)
- B06-2a (Run teslim commit'ine sabit; replay kayıtlı custody'den), OWNER-EVE-SMALL (serve başlangıç reddi, modül ad alanı kapalı),
  TL-A (görünür aşamalar, aşamalı iptal, düşünme ön izlemesi), TL-B (araç satırı deseni/özeti, 64 KiB okuma, grep context/maxHits),
  TL-C (sistem istemi, ilerlemesiz round notu, özetlemede düşünme kapalı, yerleşime bağlı okuma yasağı — güvenlik), COMPOSITION-BUDGET
  (kabul formülü engine'de tek kaynak), INFLIGHT-FIX (iptal edilen çağrı slotu bırakır; owner 2026-09-28, A3A güncellendi).
- Canlı geçişte yapılacaklar (PASS sonrası): servis yeniden başlatma → takılı slot onarımı doğrulaması (`in_flight=0`); canlı katalog Qwen
  modeline `chat-template-enable-thinking` eklenmesi (owner onayıyla); yerleşime bağlı okuma yasağının canlıda etkinleşmesi.

## Owner kararı bekleyenler
- `/reasoning off` ile tüm turlarda düşünmeyi kapatma protokol v16 ister (karar bekliyor); `@file` ekleme yolu yerleşime bağlı okuma
  yasağını henüz kullanmıyor; çöken süreçten kalan `claimed` slot (ayrı kart).
- B06-2a açıkları: `ADOPTION_NOT_DELIVERED` adı; CLI yolu (2c); sonraki dilim B06-2b (benimseme bağı + ledger v42).
- Dilim 4a: full-auto'da salt-okunur kabuk (audit olay v2) ve `rm`; `lane/l5-i40` (birleşmemiş tanı testi).
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` (+ bu akşam biten şeritler, stash'ler).
