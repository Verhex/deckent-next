# Anlık iş akışı — kısa süreli hafıza (owner 2026-10-10)

Owner 2026-10-10: bu dosya **geçici işleri ve kimde olduklarını** taşır; biten iş buradan **silinir** (kalıcı kayıt PLAN/COMPLETED-PLAN/CHANGELOG'a gider). Ana oturum günceller. Kalıcı kaynaklar: `PLAN.md`, `ARCHITECTURE.md`, karar günlüğü, host panosu (`node .agents/refactor/board.mjs show`), iş planı panosu https://claude.ai/artifact/1ESSNiUPCxWVRa8mw9va2Q.

Son güncelleme: 2026-10-29 (lead 6ea3ba88). **Canlı = N1 runtime = alpha.57** (`7c624d18d4d4-c38d723545f7`, 11:27Z). N1 KAYNAK = `7c624d18d`. Lead tek yetkili. Sıra owner 2026-10-29'dur (PLAN “alpha.57 sonrası owner sırası”).

| İş | Kimde | Durum | Sonraki adım | Belge borcu |
|---|---|---|---|---|
| 1 CI kayma bekçisi, ağırlık tazeleme, model-activation testini bölme (şerit A) | Lead; Claude alt ajan, `fix/ci-drift-guard` worktree'si | Sürüyor | HANDOFF → lead toplu PR'a alır | ci-and-verification modül notu (şerit A) |
| 1 project-init 30 sn zaman aşımı ve RESTART-HUNT tanısı (şerit B) | Lead; Claude alt ajan, salt okunur | Sürüyor; CI artefaktları ~2026-11-05'te silinir | DIAGNOSIS → gerekirse düzeltme kartı | — |
| 2 alpha.57 belge turu (şerit C) | Lead; Claude alt ajan, `docs/a57-pass` worktree'si | Sürüyor | HANDOFF → toplu PR | 10-29 analiz kararları owner-decisions'ta yok (lead) |
| Sürümsüz toplu PR (1 + 2) | Lead | Şeritler bekleniyor | Hedefli kontrol → Astra → exact-head hosted CI yeşil → owner onayıyla merge | — |
| 3 evet/hayır tuş kuralı, 4 BeUser başlangıç durumu, 5 Node 26.13.0, 6 harcama kayıtları | Lead | Sırada; 26.13.0 host'ta kurulu | 1–2 indikten sonra sırayla; 3–4 sonrası yalnız walk16'nın üç yolculuğu yeniden yürür | PLAN takip listesi |
| Oynak saat testi `terminal-turn-phases.test.ts:144` (2026-10-22 notu) | Lead | Kart açılmadı; güncel durumu doğrulanmadı | Yeniden görülürse enjekte saat kök neden kartı | — |
