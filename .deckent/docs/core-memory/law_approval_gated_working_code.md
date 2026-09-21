---
name: law_approval_gated_working_code
description: KANUN — kanıt=ÇALIŞAN KOD (test-yeşili değil) + per-madde kanıtlı rapor; Alperen-onayı approved-DAG sınırında; onaysız atlama/erken-zafer YASAK
metadata:
  type: feedback
---

**(a) Kanıt:** test-yeşili/test-sayısı BAŞARI KANITI DEĞİLDİR — "düzgün çalışmayan kodun düzgün çalışan testi işe yaramaz." Tek kanıt = deckent'in gerçekte doğru çalışması (canlı-üretim çıktısı, gerçek-binary davranış, kullanıcının yaşadığı sonuç). Raporlarda test-metrikleri zafer-dili olamaz; "TAMAM/🏁" ilanı yalnız Alperen'in kendi doğrulamasıyla.
**(b) Akış (amendment — Alperen 2026-08-17):** madde biter → **kanıtlı rapor her madde için yazılır** (rapor SEYRELMEZ, kanıt zinciri kesintisizdir) → **owner-approved execution tree (approved DAG) içinde execution kesintisiz sürer**. **Alperen onayı DAG-sınırında alınır:** scope, authority, destructive/external state veya product-direction değişen her noktada durulur ve sorulur. Onaysız kapsam-değiştirme, madde-atlama, erken-zafer ilanı YASAK kalır. Aynı işe defalarca dönmek kabul edilemez — ilk turda kök-tam-çözüm. Canonical: `docs/governance/deckent-dev-operating-policy.md` §9.
