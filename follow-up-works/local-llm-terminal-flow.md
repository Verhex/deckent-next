# Worktree — inference + Ink terminal (replaceable)

Cwd: `/home/alperen/deckent-next-wt-local-llm` · branch `feat/local-llm-terminal` · main senkron: owner manuel / `sync-main-into-branch.sh` (**`-X theirs` kullanılmaz**).

## Kilitleme (Astra 2026-09-22)

- **Paket A** → sınır düzeltmeleri + verify + PTY kanıtı → **owner onayıyla main merge**.
- **Paket B** → ortak runtime client, olay aboneliği, tam yürütülebilir terminal (`do`/run/onay).
- Workline kalıcı yüzey; snapshot dosyası Desktop kalıcı kanal değil (geçici köprü).

## Paket A merge öncesi (durum)

| Kapı | Durum |
|------|--------|
| invoke_model sessiz HTTP fallback kaldırıldı | `block.ts`, `prepare-turn.ts`, `turn.ts` |
| Varsayılan backend invoke_model; inference_http açık seçim | `config.ts`, `.agents/inference/terminal-chat.dev-http.example.json` |
| Model id exact match | `openai-models.ts` |
| HTTP chat credential: yalnız `DECKENT_INFERENCE_API_KEY` | `chat.ts` |
| Admission = per-run tahmin (broker iddiası yok) | `admission.ts` JSDoc |
| `build:terminal-tokens` map’ten üretir | `scripts/build-terminal-palette.mjs` |
| Docker publish loopback | `start-qwen38.mjs` `127.0.0.1:` |
| Bridge snapshot atomic write | `terminal.ts` |
| Ledger/chat bounded | `workline.tsx` |
| Otomatik terminal/PTY test | **açık** — merge kapısı |
| Config loader → chat-plan integration test | **açık** |
| Workline inference kapalıyken run inceleme | **Paket B / ayrı dilim** |

## Mimari (durable)

- **Terminal Contract v1:** `ARCHITECTURE.md` → “Operator terminal contract v1”.
- **Pazar:** `deckent-refactor-work/proof/TERMINAL-UI-LANDSCAPE/00-deckent-positioning.md`.

## Kod özeti

- `inference_serving`, admission, `terminal session|workline`, Ink, `composition/core/terminal-chat`.
- Kanıt: `deckent-refactor-work/proof/LOCAL-LLM-INFERENCE/`.

## Paket B (sıra)

1. Runtime push → ledger (watch poll ürün gözlemi olarak kalabilir; freshness sözleşmesi).
2. `invoke_model` → ortak runtime client (composition path bugün `invokeConfiguredModel`).
3. Desktop ortak runtime sorgu/olay (snapshot kaldırma).
4. Tam token pipeline (`build:tokens` parity).

Operatör: `.agents/inference/README.md` — yerel sohbet için `terminal.chat.backend: inference_http` veya `DECKENT_TERMINAL_CHAT_BACKEND=inference_http`.
