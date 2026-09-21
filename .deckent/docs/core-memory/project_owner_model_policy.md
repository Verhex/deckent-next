# Owner Model Policy (OWNER-MODEL-POLICY-001) — Provider-Scoped Activation Kararı (2026-08-16)

**Tip:** project / kalıcı-durum (law değil; genişletme değil, referans-karar).

`ModelActivationStore` (schema v1→v2) üzerine **provider-scoped policy mode**
eklendi: `implicit-active` (default, byte-compatible — kaydı olmayan model
eligible) karşısında `explicit-active` (YALNIZ owner'ın `active=true` kaydı
çalıştırılabilir; yeni tespit edilen/katalog modeli havuza ASLA kendiliğinden
giremez). `MODEL-ACTIVATION-001`'in doğrudan successor'ı.

## Sabitlenen kararlar
- **Tek authority = `ModelActivationStore`** (`.deckent/models.db`). Paralel config
  allowlist / env / instruction-katalog YOK (KANUN 10 — 0-hardcode).
- **`default_model` bir TERCİH'tir, kesin tavan DEĞİL.** Sert çalıştırma sınırı
  owner active-set'idir (`deckent models active-set`).
- **Enforcement zinciri:** bootstrap snapshot injection (`provider.ts` →
  `mr.setActivationPolicy`, planner-policy'den önce; `snapshotDigest` →
  `BootstrapResult.modelActivationDigest`) → registry read-filter **tombstone**
  (pool accessor'ları gizler, identity/accounting accessor'ları TOTAL kalır,
  parametrik re-register diriltemez) → `forceModel` Layer 0 typed HOLD →
  pre-dispatch admission typed HOLD. `MODEL_INACTIVE` asla sessiz ikame değildir.
- **Owner explicit-active set:** claude {fable-5, opus-5, sonnet-5,
  haiku-4-5-20251001} · codex {gpt-5.6-sol, terra, luna} · local-llm
  {Qwen3.8-27B}. `gpt-5.5` INACTIVE (negatif real-binary canary ile kanıtlı).
- **FAZ-0 = manual bootstrap seam, kanıtlı** (32 hermetic + 248 regression yeşil,
  tsc temiz, gerçek build, canary 5/5; digest `sha256:759fb7e7a3f45bf8…`).
  MASTER ledger'da `MODEL-ACTIVATION-001` gibi typed-residual taşıyan bir
  `VERIFY` satırıdır — terminal DONE closure ayrı owner-receipt işidir.

## FAZ-1 (KURULU — gerçek Terminal/worker/GPU kanıtlı)
local-llm üretim zinciri `authMode=local` ile credential/Authorization üretmeden,
`executionCostClass=local` ile sıfır-uzak-maliyet sınıfında çalışır. Config → provider
bootstrap → registry identity/fresh-health → Terminal native transport →
http-agentic-worker → durable settlement consumer zinciri ve
`deckent local-llm start|status|stop` lifecycle yüzeyi bağlıdır.

Qwen3.8-27B ile gerçek kanıt:
- Sprint-533 2/2 COMPLETE; sprint receipt digest
  `103e8f64d9d989f8fd32a8d5777c67c2710e0640b2b810f2386409abc8f4e237`.
- Terminal Deckent tool çağrısıyla `package.json` okuyup `0.100.0` döndürdü.
- Worker host-adapter yolundan provider usage + `DONE` result + durable settlement
  üretti: `worker-execution:e50422ac35180a57be52ad08b7b19bcceb98ca5c360be901bfa3e8243a5c139d`.
- Owner-authored `local_llm.acceleration` ile CUDA0/RTX 5090 placement sessiz CPU
  fallback olmadan çalıştı; Terminal yaklaşık 44 s, worker transport 7064 ms.
- Scoped local-llm suite 29/29 ve gerçek build yeşil. Daemon owner isteğiyle
  kapatıldı; runtime wiring/config korunuyor.

## Dürüst follow-up
Canlı `models.dev` kataloğu `gpt-5.6-terra`/`sol`'u tier `premium` projekte
ediyor; owner-reviewed BUILTIN merdiven ise terra=standard, sol=premium_plus,
luna=economy (hermetic tier testi owner-reviewed merdivene assert eder).
Projection uzlaştırması izlenen ayrı follow-up'tır ve **activation sözleşmesini
etkilemez**; local-llm modeli owner explicit-active set'iyle çözülür.

Extended spec: [`docs/governance/owner-model-policy.md`](../../../docs/governance/owner-model-policy.md) ·
MASTER ledger: `OWNER-MODEL-POLICY-001` (`docs/MASTER-PLAN.md`).
