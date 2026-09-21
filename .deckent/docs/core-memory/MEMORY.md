# Memory — 15 KALICI KANUN (Alperen-seçimi; genişletme yalnız Alperen-onayıyla)

> Bu dosya ve aynı dizindeki referanslar bu repo için canonical ürün/geliştirme core-memory authority'sidir.
> Provider/host HOME kopyaları yalnız projection'dır. İş-takibi burada değil → `PLAN.md`; geçici ilerleme `follow-up-works/current-flow.md`.
> Her satır tek hook'tur; operatif ayrıntı dosyanın kendisindedir.

Ortak ürün hedefi ve karar ölçütü: **[Product north star](project_product_north_star.md)**.
Ürün hedefi, mevcut uygulama ve tarihsel kanıt ayrı iddialardır; canlı owner talimatı üstündür.

## Kanunlar

1. **[Ölçek + MVP-yasağı + agentic-OS](law_scale_no_mvp_agentic_os.md)** — milyon-ölçek/cross-platform baştan; MVP ASLA; hedef-kimlik AI runtime-ecosystem/agentic-OS.
2. **[ADR'ler ihlal edilemez](law_adr_inviolable.md)** — değişiklik öncesi ilgili mimari/ADR kaynak okuması; çelişkide önce amendment-önerisi.
3. **[Kanıt = çalışan kod + DAG-sınırı onayı](law_approval_gated_working_code.md)** — test-yeşili tek başına ürün kapanışı DEĞİL; her madde kanıtıyla raporlanır; onay approved-DAG sınırında (scope/authority/destructive/external); onaysız atlama ve erken-zafer YASAK (amend. 2026-08-17).
4. **[Türkçe + SSOT](law_turkish_and_ssot.md)** — anlatım hep Türkçe, teknik terim EN; yalnız owner-admitted outcome PLAN kapsamında ilerler; finding otomatik iş değildir (amend. 2026-08-17).
5. **[Test ≤16 GB](feedback_vitest_16gb_local_cap.md)** — lokal koşum 16 GB'ı aşamaz; `VITEST_MAX_FORKS=2`.
6. **[Fix-döngüsünü kır](feedback_break_sprint_bug_cycle.md)** — tekrarlayan reaktif fix-döngüsü yasak; closure paketleri yalnız kendi closure'ını taşır; forward işi ayrı committed outcome (amend. 2026-08-17).
7. **[Terimleri açıkla](feedback_explain_technical_terms.md)** — teknik terimler Alperen'e inline açıklamayla anlatılır.
8. **[Mikro-task + dependency DAG](feedback_scale_up_autonomous.md)** — task sayısı ve paralellik instruction metninden değil effective config, DAG, collision/resource policy ve provider capacity'den çözülür.
9. **[Proof-of-Function + engel-bildirimi + Brain-karar](law_proof_blockers_brain_eval.md)** — user-surface DONE = gerçek-binary koşu; yönlendirmeden önce blocker'ları söyle; ürün kabul rolü ve gerçek kanıt ayrımı.
10. **[0-hardcode](feedback_zero_hardcode_live_data.md)** — model-adı/akış-değeri literal'i kod yolunda YASAK; tek kaynak registry + config (ADR-G-036 + ratchet).
11. **[Memory-iş ayrımı](law_memory_vs_work_separation.md)** — her kayıtta sor: iş mi (→PLAN) kalıcı durum mu (→memory)? Yeni kalıcı politika belirsizse ownera danış; mevcut izni tekrar sorma.
12. **[Kod + iş-özeti birlikte](feedback_code_plus_business_summary.md)** — her işi/raporu hem kod detayı hem düz-Türkçe iş tanımıyla sun; Alperen kodu açmadan karar verebilsin.
13. **[Alp Discipline = karar-çapası](law_alp_discipline_anchor.md)** — tarihsel Alp Discipline dersi: negative-space → sınır-içi-alternatif → kayıpta-dur → irtifa-ilanı.
14. **[Cross-provider xverify + production-closure](feedback_xverify_clarification_option.md)** — ciddi kök-neden/tasarım belirsizliğinde farklı provider'dan ikinci görüş; sonuç karar veya authority devri DEĞİL. Legacy xverify dersi; Nextte Jev danışman, Fable kapalı. HOLD/UNCLEAR kapanış değil.
15. **[Disk-kanıt-önce-iddia](feedback_disk_evidence_before_claims.md)** — status/projection çıktısı kanıt DEĞİL; canlılık/ilerleme adapter custody + süreç/heartbeat/log/result doğrulamasıyla; varsayım etiketsiz söylenmez.

## Kanun olmayan kalıcı feedback

- **[Koşum ve build kadansı](feedback_verification_cadence.md)** — Next landing öncesi npm run verify; kaynak değiştiyse build zorunlu; suite koşarken build yasak. *(2026-09-20'de `full_suite_cadence` + `build_after_source_change` birleşti.)*
- **[Yaşayan dokümanlar](feedback_living_documents.md)** — kalıcı ders memory; ana karar PLAN; geçici ilerleme current-flow; kanıt dış proof alanı. *(2026-09-20'de `ai_operator_lessons_doc` + `migration_ledger_and_support_mode` birleşti.)*
- **[Kısır-döngü darboğazlarını bildir](feedback_report_bottleneck_loops.md)** — `max_workers=1` / tek-task / erişilemez FIX / attribution-döngüsü görülür görülmez Alperen'e raporlanır.
- **[XVerify claim disiplini](feedback_xverify_claim_discipline.md)** — landing öncesi diff ve gerçek davranış kanıtı; nokta-iddia + eşlik eden target; evrenseller makine-gate işi.
- **[Worker model tier routing](feedback_worker_model_tier_routing.md)** — kritik yüzey işi üst tier'a; somut model adları aktif set'ten çözülür (Kanun 10).
- **[Provider-bağımsız fallback yetki devri](feedback_fallback_authority_handover.md)** — engelde target effective config + kanıttan çözülür; legacy devir zinciri dersidir, Next uygulama iddiası değildir; dokümanı okumak devir değildir.

## Referans kararlar (law değil — kalıcı proje durumu)

- **[Cursor ortamı + provider adayı](project_cursor_environment_provider.md)** — tarihsel login güncel erişim kanıtı değildir; üç provider aynı sınırda gerçek denemeyle doğrulanır.
- **[Closure OS sidecar-ledger foundation](project_closure_os_foundation.md)** — legacy foundation/settlement dersleri; **HOLD ≠ closure**; Next wiring ayrıca kanıtlanır.
- **[Owner model policy — provider-scoped explicit-active](project_owner_model_policy.md)** — provider-scope activation; legacy store Next implementation iddiası değildir; explicit-active'te yeni model havuza kendiliğinden giremez; `default_model` tercihtir, sert sınır owner active-set'idir; sessiz ikame yok; güncel Next sonucu ayrıca doğrulanır.
- **[Dev operating contract](project_dev_operating_contract.md)** — Next tek yürütme reposu; legacy read-only; Fable kapalı; DOGFOOD_MODE=OFF.
