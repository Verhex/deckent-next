---
name: feedback_vitest_16gb_local_cap
description: "BAĞLAYICI: lokal test koşumu ≤16GB RAM — üstü YASAK. Lokal vitest maxForks sınırsızdı (20 çekirdek×~2GB=~40GB) → WSL OOM-crash. vitest.config.ts CI=2 / local=4 fork'a sınırlandı; full-suite tek-process yerine küçük bölünmüş batch'ler koş."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ac403a05-0d82-4821-85f5-1d8750e639bc
---

Alperen (2026-06-28, iki ayrı direktif): **"testler için maks 16GB RAM — üstü kullanım YASAK"** + **"sistemin tüm gücünü kullanma, işleri böl, optimal koştur — sürekli WSL shutdown oluyor."**

**Why:** `vitest.config.ts`'te lokal `poolOptions.forks.maxForks: undefined` (sınırsız) idi → 20-çekirdekli makinede her çekirdeğe bir fork × ~2GB = ~40GB peak → WSL OOM → makine kapanıyor (kullanıcı "panic" gibi şeyler görüyor + VS Code'a yer kalmıyor). Bu, gördüğüm "Channel closed / SIGTERM / onTaskUpdate timeout" full-suite çökmelerinin GERÇEK sebebiydi — flaky test değil, OOM.

**How to apply:**
- Fix landed: `vitest.config.ts` → `maxForks: process.env.VITEST_MAX_FORKS ? Number(...) : (process.env.CI ? 2 : 4)` + `minForks: 1`. 4 fork × ~3.5GB ≈ 14GB (≤16GB, VS Code'a headroom). CI 16GB-runner'da 2 kalır.
- **Doğrulama koşarken:** full 25k-test suite'i TEK process'te koşma (OOM riski + yavaş). `VITEST_MAX_FORKS=2` ile **küçük dizin-batch'leri** koş (örn. dokunulan dosyalar, sonra tek-tek shard: orchestra / cli+mcp+integration). Peak bellek 3-6GB'da kaldı, 16GB'ı asla geçmedi.
- Orchestra fork'ları CI'da 8GB heap (NODE_OPTIONS) kullandığı için global execArgv heap-cap KOYMA (orchestra'yı kırar) — bellek kontrolü yalnız **fork-sayısı** üzerinden.
- CI shard'ları zaten ≤16GB (maxForks=2, 16GB runner) — CI tarafı ek-tuning gerektirmedi.

