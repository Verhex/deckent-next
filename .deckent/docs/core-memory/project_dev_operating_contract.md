---
name: project_dev_operating_contract
description: 2026-08-17 Alperen onaylı dev-operating-contract — kanun 3/4/6 amendment, DOGFOOD_MODE=OFF, Paket A→B, Fable Brain + subagent + Sol xverify modeli
metadata:
  type: project
---

**Alperen onayları (2026-08-17, dört madde):**
- **(a)** Kanun 3/4/6 amendment'ları ONAYLI ve UYGULANDI (bu commit — canonical:
  `docs/governance/deckent-dev-operating-policy.md` §9): Kanun 3 → rapor per-madde kalır,
  Alperen-onayı approved-DAG sınırına taşınır. Kanun 4 → yalnız owner-admitted
  outcome/residual AYNI GÜN MASTER satırı; finding otomatik iş değildir. Kanun 6 →
  incident/closure paketleri yalnız kendi kapsamını taşır; forward işi ayrı committed outcome.
- **(b)** `DOGFOOD_MODE=OFF` (landing + Paket A + Paket B) + Paket A→B sırası ONAYLI.
  ON-dönüş koşulu: Paket B DONE (runPolicyAuthority task-carried wiring + provider
  policy-digest parity hermetic testi + no-op dogfood canary terminal settlement).
- **(c)** Paket B **ürün kodu olarak** yazılır — 487-026 `task.productionWiring` pattern'i
  ("can never be gated off by caller wiring drift"); ctx-injection pattern'i (486-017'nin
  stranded bıraktığı yol) KULLANILMAZ; deckent-dev ilk tenant.
- **(d)** PR #127 push + root-dirt typed disposition ONAYLI (uygulandı: landing başka
  oturumda tamamlandı, dirt records-commit'i + branch/worktree temizliği yapıldı).

**Çalışma modeli (Alperen, 2026-08-17):** Brain = Fable 5 (max effort); provider fark
etmeksizin 0 kural-ihlali hedefi — kesinlik `lint-operating-policy.mjs` (host parity) +
Paket B (worker-prompt delivery) ile mekanikleşir. Detay işler Sonnet/Opus subagent'lara
delege edilebilir; kritik analiz/eleştiride deckent xverify ile gpt-5.6-sol ikinci görüşü
(Kanun 14 sınırlarında — karar/authority devri değildir).

**AKIŞ DEĞİŞİKLİĞİ (`DECISION_REF=owner-live-2026-08-17-direct-main` — ürün tamamlanana kadar):**
Aktif mode değerleri YALNIZ `AGENTS.md`/`CLAUDE.md` başındaki machine-readable
`DECKENT-DEV-CONTROL` bloğundadır (gate: `lint-operating-policy.mjs`): DOGFOOD_MODE=OFF,
WORKSPACE_MODE=MAIN, DELIVERY_MODE=DIRECT_MAIN, PR/merge-queue optional, REMOTE_CI=ADVISORY,
LOCAL_VERIFICATION=REQUIRED, EXECUTION_AUTHORITY=FABLE, ANALYSIS_AUTHORITY=CODEX. Çalışma
doğrudan root `main`'de; worktree YALNIZ gerçek paralellik gerektiğinde. **GitHub branch
protection/ruleset/security ayarlarını Alperen yönetir; agent değiştirmez** (mevcut durum:
`main-protection` ruleset id 20321963 owner kararıyla `disabled`, effective rules `[]`).

**Sıra:** Paket A (`DEV-OPERATING-CONTRACT-001`) → Paket B (`RUN-POLICY-DELIVERY-001`) →
Phase-5 writer (mode kararı Alperen'in) → RUN-INSPECTOR-001 → Terminal/Desktop treni.
İlgili: [[project_closure_os_foundation]], [[project_owner_model_policy]].
