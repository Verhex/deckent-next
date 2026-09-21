---
name: feedback_zero_hardcode_live_data
description: "Zero-hard-code felsefesi — tüm CLI/MCP çıktıları canlı deckent verisi + parametrik, stale model ID/sürüm yasak"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 89c2bcbe-de85-4468-bb6d-2fa12f4b7622
---

Alperen direktifi (Sprint 206, 2026-05-31): **zero-hard-code felsefesi.** Tüm CLI ve MCP çıktıları güncel, doğru ve deckent'in canlı içeriğinden parametrik beslenmeli. Hard-code süreçleri olabildiğince minimize, hatta sıfırla.

**Tetikleyen bulgu:** `deckent start` cost-estimate çıktısı `claude-opus-4-6` / `claude-sonnet-4-6` gösterdi — oysa güncel Opus **4.8**. Kök neden: `src/core/model-registry.ts:62` `BUILTIN_MODELS` bundled snapshot `apiId: 'claude-opus-4-6'` hardcoded (stale). `bootstrapFromCatalog()` (cli/entry.ts:41 wire'lı) models.dev canlı catalog'u çekiyor ama 3-stage fallback (fetch→cache→bundled) fetch başarısız/timeout ise bundled stale değere düşüyor. cost-estimator registry apiId'sini doğrudan basıyor → ekrana stale değer.

**Why:** deckent god-level ürün; kullanıcı CLI/MCP çıktısında yanlış/eski veri görmemeli (model adı, sürüm, sayaç, metrik). Hard-code = bakım borcu + güven kaybı. Canlı veri = doğru + bakımsız güncel kalır.

**How to apply:**
- Model ID/apiId/fiyat → models.dev catalog + pricing-updater'dan canlı; bundled sadece offline son-çare ve "bundled (stale olabilir)" etiketiyle işaretli olmalı.
- CLI/MCP çıktılarındaki her sabit değer (model, sürüm, sayaç, tier, agent/skill sayısı) → deckent runtime verisinden türetilmeli, manifest/registry/config'ten okunmalı.
- Yeni kod sabit string/sayı basacaksa: "bu canlı veriden gelebilir mi?" sorusu zorunlu. Gelebiliyorsa hard-code etme.
- Bundled snapshot'lar periyodik güncel tutulmalı VEYA build-time models.dev'den generate edilmeli (ideal: kaynak tek = models.dev).

Sprint 207+ teması: "Live-Data / Zero-Hard-Code" — model-registry bundled refresh + cost-estimator catalog-aware + CLI çıktı parametrikleştirme audit.


---

**🔴 KESİN-KURAL yükseltmesi (Alperen, 2026-07-12):** "Sistemde hardcode bir akış ASLA istemiyoruz — her şey sistematik ve parametrik olacak. Sonnet kullanmayan kullanıcı olursa sistem ayakta kalamazsa, sonnet model-adı değişirse sistem ayakta kalamazsa patlarız. 0 hardcode; bu kural ADR'lerde mevcut olmalıydı." Kapsam yalnız CLI-çıktısı değil: **model-adı/provider/akış-değeri literal'i kod-yolunda YASAK** — literal yalnız model-registry/catalog SSOT'unda yaşar; tüm default'lar tier-bazlı registry-türevi + config-override'lı çözülür. Program: born-683 / MASTER-PLAN 565 (ADR + lint-ratchet [lint-no-spawnsync emsali] + resolveDefaultModel/resolveBrainModel tek-kaynak). İlk dilim born-682 (do-planner 'sonnet'). Envanter 2026-07-12: src'de ~19 gerçek-ihlal (config DEFAULT_MODES, tmux.ts spawn-fallback, mcp/run + cli agent/run default'ları, autonomous realPlannerComplete×2).
