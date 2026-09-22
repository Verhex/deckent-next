# Host inference — Qwen3.8 + Deckent terminal

Worktree kökünden (`~/deckent-next-wt-local-llm`).

## Tek komut akışı

```bash
# Durdur (18080, 8000, llama/vLLM konteyner)
node .agents/inference/start-qwen38.mjs --stop
# veya
node .agents/inference/stop-inference-host.mjs

# Başlat — varsayılan GPU Docker (Qwen3.8-27B-Q4_K_M, :18080)
node .agents/inference/start-qwen38.mjs

# Ink workline (sunucu yoksa otomatik start dener)
DECKENT_NODE_HEADERS=/usr/include/node npm run build   # ilk sefer / kod değişince
./.agents/inference/run-workline.sh
```

**404 `not_found_error`:** Genelde tarayıcıda `GET /v1/chat/completions` veya **8080** (Apache) — doğru uç **POST** `http://127.0.0.1:18080/v1/chat/completions`. Doğrula: `node .agents/inference/probe-chat.mjs`.

Ink açılmadıysa: `start-qwen38` + `build` yetmez; mutlaka **`./.agents/inference/run-workline.sh`** (etkileşimli TTY).

## Ortam

| Değişken | Varsayılan |
|----------|------------|
| `DECKENT_QWEN38_LAUNCHER` | `docker` (CUDA). `native` = `/usr/local/lib/ollama/llama-server` (CPU). |
| `DECKENT_QWEN38_PORT` | `18080` |
| `DECKENT_QWEN38_MODEL` | `~/.local/share/local-llm/models/Qwen3.8-27B-Q4_K_M.gguf` |

Config: `.deckent/config.json` → `host-qwen38-q4` (ikinci profil: `host-qwen38-q6`).

## Eski scriptler

- `launch-qwen38-llama.mjs` — yalnızca native CPU yolu; port çakışmasında `--force-restart`.
- `start-qwen38.mjs` — **birincil** giriş noktası.
