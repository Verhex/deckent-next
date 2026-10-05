# Owner hedefleri — 2026-10-05 (yeni iş alanları)

Owner 2026-10-05 hedefleri; hiçbiri uygulama kabulü değildir. Her biri kendi kartında Jev hazırlığı, güncel resmi kaynak doğrulaması (CLAUDE.md çalışma yöntemi) ve ayrı inceleme ister. PLAN.md tablosundaki satırların ayrıntısıdır.

## NATIVE-AGENTS (öncelik #4–#7)
- #4 OpenCode, #5 GitHub Copilot CLI, #6 Kimi Code CLI, #7 Google Antigravity/Gemini.
- Her biri native CLI kayıt defterine (`assets/native-coding/commands.json`; bugün codex, claude, cursor) yeni giriş + credential spec + worker imajı + model-usage kanıtı gerektirir; mevcut worker imajı/toolchain güncellik politikası ve izin modu sözleşmesi aynen uygulanır.
- Devin bir uzak ajan API'sidir; yerel CLI kaydı değil, ayrı bir remote-worker adaptörü gerekir.

## MODEL-PROVIDERS (öncelik #8–#9)
- #8 GLM, #9 DeepSeek: model/provider kayıtları mevcut `provider-openai-chat` (OpenAI uyumlu) veya `provider-openrouter-chat` adaptörleriyle katalog verisi olarak eklenir; yeni adaptör yalnız kanıtlı bir yetenek açığı varsa.

## SIWC — OpenAI "Sign in with ChatGPT"
- PKCE OIDC; açık kaynak geliştiriciler uygun; yalnız Responses API kapsamı. Kaynaklar: `/home/alperen/deckent-refactor-work/proof/SUBSCRIPTION-LOGIN-2026-10-05/sources.md`. Önce tasarım ve uygunluk kartı.

## CLAUDE-API-KEY-TERMINAL
- Native terminalde Claude, API anahtarıyla. Anthropic üçüncü taraf claude.ai girişini ve abonelik OAuth'unu yasaklar; abonelik yolu yalnız değiştirilmemiş Claude Code worker'ıdır. Test sonra.

## CI-DEBT, BOARD-DASHBOARD, B36, QWEN–JEV
- CI-DEBT: owner'ın ayrı Codex ajanı, `/home/alperen/deckent-refactor-work/proof/CI-DEBT-2026-10-05/STATUS.md`.
- BOARD-DASHBOARD: Codex lane'i; PR #14 indi. B36 gerilemeleri: PR #12 indi (Astra 2365 PASS, main `0e773b3b`).
- QWEN–JEV gölge karşılaştırma: 2/20 vaka; ayrıntı [qwen-host-pilot](qwen-host-pilot.md).

## COMPUTER-USE
- Deckent'in kendi computer-use katmanı (Claude Cowork, Codex computer use, Perplexity Computer sınıfı); masaüstü uygulamasıyla birlikte geliştirilir ve uygulama özelliği olarak sunulur.
- DESKTOP-ARCH (D1–D7, Electron 44 ↔ Tauri 2 ölçümü, Windows+WSL) ile bağlıdır; dayanak: owner 2026-10-03 dalga 6 "kendi computer-use mekanizması (kesin)" ([work-list](work-list.md) DALGA-6).
- Principal/scope/policy kapıları ve onay modeli korunur: ajanın ekran eylemleri yönetilen etkidir (genel etki-settlement portu; modüle özel yeni etki akışı yok).
