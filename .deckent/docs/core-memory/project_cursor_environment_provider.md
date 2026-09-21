---
name: project-cursor-environment-provider
description: Ortam artık VS Code değil Cursor; cursor-agent CLI provider-adayı, xverify hedefi grok-4.6 (Alperen 2026-08-19)
metadata:
  type: project
---

Alperen 2026-08-19: çalışma ortamı artık VS Code değil **Cursor**. `cursor-agent` CLI
kullanılabilir; Cursor bir **provider** olarak kabul edilip modelleri kullanılabilir —
xverify'da **grok 4.6** Cursor üzerinden hedef. Cursor üyeliği + limiti var. Talimat:
"önce test edip sonra işleri güncelle" — test 2026-08-19'da yapıldı, iş MASTER'a
admission edildi (7091 CURSOR-PROVIDER-001).

Test kanıtları (2026-08-19):
- `cursor-agent` v2026.08.11-e8db854, login: owner hesabı (`cursor-agent status`).
- Katalog (`--list-models`): `cursor-grok-4.6-{low,medium,high,xhigh}[-fast]`,
  `gpt-5.6-sol-{high,xhigh}[-fast]`, `gpt-5.6-luna-high`, claude opus/sonnet/fable
  thinking tier'ları, `gemini-3.7-flash-high`, `composer-2.5`.
- Gerçek çağrı: `cursor-agent --mode ask -p --trust --output-format json --model <m> "<prompt>"`
  → `{"type":"result","result":"…","session_id","request_id","usage":{inputTokens,outputTokens,
  cacheReadTokens,cacheWriteTokens}}` — provider-reported usage VAR (xverify kapanış zinciri
  uyumlu). grok-4.6-high (text `OK`) + gpt-5.6-sol-high (json `PING`) ikisi de kanıtlandı.
- Dizin-güven ister: non-interactive'de `--trust` şart; `--mode ask/plan` read-only
  (verifier izolasyonu için doğru mod).

**Why:** XVerify provider-ayrımı için codex'e ek ikinci bağımsız rota (grok-4.6 tamamen
farklı model ailesi) + Sol'a yedek erişim yolu.

**How to apply:** deckent provider adapterı yazılana kadar xverify `--verifier` enum'unda
cursor YOK — iş MASTER 7091'de; adapter model/limit çözümü CONFIG-RESOLVED olmalı
([[feedback_zero_hardcode_live_data]] + [[project_owner_model_policy]] explicit-active
disiplini).
