---
name: feedback-break-sprint-bug-cycle
description: "Sprint-bug döngüsünü kır — her sprint mevcut bug'ı fix etmek için planlanırsa kısır döngü oluşur; ileriye git, ship & iterate, kalıcı yapı kur, kısa-vade fix tuzağına düşme."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 831d4c9f-6acf-418d-aeab-2f47a8741e57
---

**Kural:** Sprint planlanırken **sadece bug fix odaklı sprint yasak**. Her sprint en az 1 ileri-yönlü vizyon task'ı (W-E evrimsel, W-K dead-code wire, W-H docs growth) içermeli. Bug fix → fix the fix → fix the fix of the fix döngüsü = stagnation.

**Amendment (Alperen 2026-08-17 — operating policy §9):** Yasak olan **tekrarlayan reaktif fix-DÖNGÜSÜDÜR**, tekil bounded closure paketi değil. Incident, release-closure, CI-repair, recovery ve settlement paketleri YALNIZ kendi closure kapsamını taşır — bunlara zorla feature EKLENMEZ. Forward/vizyon işi ayrı committed outcome olarak yürür. Canonical: `docs/governance/deckent-dev-operating-policy.md` §9.

**Why:** Crisis Stabilization Initiative (Sprint 177-183) 7 sprint sadece bug fix'e harcandı — momentum kaybedildi, Trinity 3-face gelişimi durdu. Çıkış stratejisi: Sprint 184+ yeni feature task'ları zorunlu, bug fix paralel.

**How to apply:**
- DIRECTIVES'te "fix-only sprint" YASAK (en az 1 forward task)
- "Sprint N bug'ı fix" task'ı yerine "sprint N bug'ı kalıcı önleyici altyapı kur" task'ı
  * Örnek: "Docker OOM fix" yerine "WSL2 tier-aware scheduler" (Sprint 197 197-004)
  * Örnek: "Sentetik NO_GO bug fix" yerine "disk-verify gate + MANUAL_REVIEW_REQUIRED status" (Sprint 195 195-001)
- Ship & iterate: half-baked feature ship etmek yerine kalıcı yapı kur, ship, iterate
- Sprint 195-197 başarı pattern'i: rescue commit + Brain dürüst raporlama altyapısı, salt fix değil

**Anti-pattern:**
- "Sprint X bug'ı Sprint Y'de fix" → ✗ kısır
- "Önce tüm bug'ları kapatın, sonra feature" → ✗ momentum ölür
- "Hızlı patch + sonra refactor" → ✗ patch kalıcı olur, refactor gelmez

**Karpathy bağlantısı:** Discipline 1 (Think Before Coding) — bug fix'in altındaki root cause'a kalıcı yapısal çözüm tasarlanmalı.

