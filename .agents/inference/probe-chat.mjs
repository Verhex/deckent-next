#!/usr/bin/env node
/** POST smoke — 404 on GET /v1/chat/completions is normal; chat must be POST. */
const port = process.env.DECKENT_QWEN38_PORT ?? '18080';
const model = process.env.DECKENT_QWEN38_ALIAS ?? 'Qwen3.8-27B-Q4_K_M';
const url = `http://127.0.0.1:${port}/v1/chat/completions`;
const body = { model, messages: [{ role: 'user', content: 'Reply: probe-ok' }], max_tokens: 24 };
const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const text = await response.text();
process.stdout.write(`${response.status} POST ${url}\n${text.slice(0, 500)}\n`);
process.exit(response.ok ? 0 : 1);
