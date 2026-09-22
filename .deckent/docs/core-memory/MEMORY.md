# Memory — 9 KALICI KANUN (Alperen-seçimi; genişletme/daraltma yalnız Alperen-onayıyla)

> Bu dosya ve aynı dizindeki referanslar bu repo için canonical ürün/geliştirme core-memory authority'sidir.
> Provider/host HOME kopyaları yalnız projection'dır. İş-takibi burada değil → `PLAN.md`; geçici ilerleme `follow-up-works/current-flow.md`.
> Her satır tek hook'tur; operatif ayrıntı dosyanın kendisindedir.
> Kapsam: ürün ilkesi / Next geliştirme uygulaması. Owner normalizasyonu 2026-09-21; owner birleştirmesi 2026-09-23 (25 → 9 dosya, Jev f2551a1d).
> Tarihsel kaynak her dosya için birleştirme öncesi Git geçmişidir; eski komut ve durumlar güncel yetki değildir.

Ortak ürün hedefi ve karar ölçütü: **[Product north star](project_product_north_star.md)** — Jev bağlamına SHA-256 ile gömülüdür, değiştirilmez. Milyon-ölçek, MVP yasağı ve agentic-OS hedefi orada tanımlıdır.
Ürün hedefi, mevcut uygulama ve tarihsel kanıt ayrı iddialardır; canlı owner talimatı üstündür.

## Kanunlar

1. **[Kanıt ve kapanış](law_evidence_and_closure.md)** — DONE = gerçek yüzey + çalışan binary + kalıcı kanıt; test-yeşili/projection/doküman/HOLD kapanış DEĞİL; engeli önce söyle; Brain kabul, Auditor denetim, Nervous gözlem; canlılık adapter custody + süreç/heartbeat/log/result ile; landing öncesi diff (amend. 2026-08-17).
2. **[Yetki sınırı ve karar disiplini](law_authority_boundary.md)** — ADR/mimari önce okunur, çelişkide amendment; onay approved-DAG sınırında; yalnız owner-admitted outcome, bulgu otomatik iş değil; otonomi ≠ izinsiz sprint; sessiz ikame/devir yok (amend. 2026-08-17).
3. **[Owner iletişimi](law_owner_communication.md)** — sade Türkçe, terim EN ve ilk kullanımda açıklanır; önce iş sonucu sonra kod kanıtı; Alperen kodu açmadan karar verebilsin.
4. **[Doküman ve memory haritası](law_documents_and_memory.md)** — ARCHITECTURE sözleşme, PLAN iş, current-flow geçici, memory kalıcı ders, kanıt dış alan; her kayıtta iş mi durum mu sor; doküman wiring değildir.
5. **[İş bölme ve kök neden](law_work_decomposition_root_cause.md)** — semptom yaması yerine kök neden + negatif kanıt; closure paketi forward iş taşımaz (amend. 2026-08-17); task/paralellik config + DAG + kapasiteden; darboğazı kanıtla bildir.
6. **[Model ve provider tek kaynaktan](law_model_provider_source.md)** — 0-hardcode (ADR-G-036 + ratchet); provider-scoped explicit-active, sessiz ikame yok; kritik iş üst tier'a; tarihsel login/liste güncel kanıt değil.
7. **[Yerel doğrulama ve kaynak sınırı](law_local_verification.md)** — test ≤16 GB, `VITEST_MAX_FORKS=2`; landing öncesi `npm run verify`; suite koşarken build yasak; makine sınırı ürün sınırı değil.
8. **[İkinci görüş, Jev ve inceleme kanalı](law_second_opinion_jev.md)** — belirsizlikte logged Jev, iki çekimser seçenek zorunlu; Jev danışmandır, PASS değil; kanal (2026-09-23): Opus uygular, Astra inceler.
9. **[Alp Discipline karar çapası](law_alp_discipline_anchor.md)** — negative-space → sınır-içi-alternatif → kayıpta-dur → irtifa-ilanı.

## Eski numara eşlemesi (2026-09-23 birleştirme)

Eski 1 (ölçek/MVP) → north star. Eski 3-kapanış, 9, 15, xverify-claim, closure-OS → 1. Eski 2, 3-onay, 4-SSOT, fallback-devir, dev-operating-contract → 2 (contract'ın kalanı `CLAUDE.md`/`AGENTS.md` "Current development phase"). Eski 4-Türkçe, 7, 12 → 3. Eski 11, living-documents → 4. Eski 6, 8, bottleneck → 5. Eski 10, tier-routing, Cursor-ortamı, owner-model-policy → 6. Eski 5, verification-cadence → 7. Eski 14 → 8. Eski 13 → 9.
