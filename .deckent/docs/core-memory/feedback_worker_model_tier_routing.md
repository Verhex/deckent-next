---
name: feedback-worker-model-tier-routing
description: Owner worker-model tier sıralaması — sol > opus > sonnet; kritik yüzey işi üst tier'a, sonnet stabil/kesin akışlı işlere; terra/luna = sonnet-eşdeğeri ve altı
metadata:
  type: feedback
---

# Worker model tier routing (Alperen, 2026-08-18)

Sprint-554 ilk planında kritik loop-wire görevi sonnet'e, test görevi sol'e atandı —
owner bunu "aşırı başarısız" olarak düzeltti.

**Kural:** Görev-model eşlemesinde kapasite tier'ı **gpt-5.6-sol > claude-opus-5 >
claude-sonnet-5**'tir. `terra` ve `luna` (codex ailesi) sonnet-eşdeğeri ve ALTI
konumlanır.

- **Kritik yüzey / çekirdek tasarım görevleri** (core module, loop/runtime wire,
  authority seam) → en işlevsel modele (sol, sonra opus).
- **Sonnet** → stabil, akışı kesinleştirilebilen işler: iyi-spesifiye test/fixture,
  deterministik dönüşüm, dokümantasyon-yakını iş.

**Why:** Model gücü görevin belirsizlik/kritiklik derecesiyle eşleşmeli; test görevi
üst tier'ı israf eder, kritik yüzeyde alt tier kalite riski üretir.

**How to apply:** DIRECTIVES yazarken per-task Provider/Model satırlarını bu tier'a
göre seç; plan çıktısında atamaları başlatmadan ÖNCE bu kurala karşı doğrula
(sprint-554'te düzeltme başlatma öncesi elle yapıldı). Kalıcı çözüm routing
policy/config'e taşınana dek her plan çıktısı bu kurala karşı gözden geçirilir.
İlgili: [[project-owner-model-policy]], [[feedback-scale-up-autonomous]].

---
**⚠ Eskimiş referans (2026-09-20, silinmedi):** tier listesindeki `sol`, `terra`, `luna` legacy dogfood
model adlarıdır ve `DOGFOOD_MODE=OFF`. Sıralama kuralı (kritik yüzey → üst tier) geçerli; **somut model
adları bugünkü aktif set'ten çözülmelidir** ([[feedback_zero_hardcode_live_data]] — model adı literal'i
kod yolunda yasak, tek kaynak registry + config). Bu kayıt [[feedback_fallback_authority_handover]] ile
bilerek ayrı tutuldu: biri model **atama sıralaması**, diğeri **yetki devri protokolü**.
