# Deckent Next — ana plan

Bu dosya yalnız **devam eden işi** taşır: kısa durum, tek iş tablosu, açık P0/P1 ve karar indeksi. Tamamlananlar [COMPLETED-PLAN](COMPLETED-PLAN.md), tarihli owner kararları ve legacy envanter [owner-decisions](.deckent/docs/decisions/owner-decisions.md), iş ayrıntıları `.deckent/docs/plan/` altındadır (SSOT sadeleştirmesi, owner 2026-10-05; hiçbir metin silinmedi). Kimde-ne-var host panosunda: `node .agents/refactor/board.mjs show`; sözleşmeler [ARCHITECTURE](ARCHITECTURE.md).

## Şimdi (2026-10-07)

- **Roller:** main Opus; bağımsız inceleyen Astra (`gpt-6-astra`, kanal `astra`); Sol yalnız analiz; lane'ler varsayılan Sonnet 5.5 alt ajan, kritikte Opus (owner 2026-10-05). DOGFOOD OFF (N1'de D4 denemeleri); canlı geçiş ayrı owner yetkisi. Rol ataması bu belgeden doğmaz.
- **Canlı = N1:** `8a940418` **1.0.0-alpha.9**, ledger 47. **main:** TERMINAL-UX T1+T2 (PR #36/#37) + toplu düzeltme → **1.0.0-alpha.10** (canlı geçiş owner komutuyla; protokol v21, servis yeni build ile başlar). CI zorunlu hücreler yalnız ubuntu node24+26 (owner ruleset 2026-10-06); hosted tam suite ~5,5 dk.
- **İlk 20 iş (owner 2026-10-06 kabul, K1–K8):** dalga 1–4 main'de ([COMPLETED-PLAN](COMPLETED-PLAN.md)); analiz `proof/WORKLIST-TOP20-2026-10-06/analysis.md`, kararlar [owner-decisions](.deckent/docs/decisions/owner-decisions.md). Sıradaki: günlük toplu düzeltme PR'ı (`fix/batch-2026-10-07`, alpha.9), ardından TERMINAL-CLOSE kalan dilimleri + EXT-SERVICE-ENTRY + BACKUP-COMMAND partisi.
- **Dogfood (N1, alpha.8):** DOGFOOD resmî OFF. `verify` türü `workspaceDelivery: none` (EXEC-RELEASE owner B; registry `dogfood-d2-c8dda210aafb9a84`); işaretten önceki 22 verify klonu (1,64 GB) süpürülmez, silme owner'da. DOGFOOD ON için S1-KURTARMA tatbikatı (`proof/W4-S1-RECOVERY-2026-10-06/RUNBOOK.md`) + BACKUP-COMMAND + owner kararı.
- **T3 açıkları (2026-10-07):** K1 owner kararıyla kapandı (seçenek A, Jev 3e7c5b38: şablon v5 `policy.administer` + onay kararı). Canlı ve N1 için owner adımı: `deckent init policy --upgrade` önizle → uygula (komutlar dış `proof/TUI3-2026-10-07/INTEGRATION-review.md`). Açık: L5 karar 1 (izleme penceresi odak almasın mı) ve 2 (`/tasks` satır içi durdur: yetki kararı). Lead seçimleri: onaydan sonra aynı seçimle uygulama, panel güveni `deckent mcp approve` motoru, `/mode show`. Kalan: B4 kök nedeni, tur içi MCP güven kartı metni İngilizce (adapter), `deckent mcp edit`, MCP-OAUTH, yeni pencerelerin canlı PTY kanıtı.
- **Teslim düzeni:** parti başına tek bağımsız inceleme, en çok bir düzeltme turu, sonra Jev ≥0,90 / ≥0,75 veya owner; Jev danışmaları `shadow.sh` ile (Qwen araştırması 2026-10-06 iptal, yalnız Jev). Önceki durum notu: [durum notları](.deckent/docs/plan/status-2026-10-05.md).

## Aktif iş alanları

| İş | Hedef | Durum | Sıradaki adım | Kanıt |
|---|---|---|---|---|
| TERMINAL-UX | Owner 2026-10-07 "kritik": insan dostu/kurumsal terminal (pencereler, onay, paneller, provider/model, MCP, Shift+Tab, açılış, istem, bölünme) | T1+T2 main'de (alpha.10). T3 `wave/tui-3`'te entegre (alpha.11 adayı): paneller, onaylı config, MCP HTTP/import/revoke/sandbox-net/öneri, `mcp-server` + şablon v5 + göç, izleme pencereleri, TERM-TEST-FIXES, protokol v22 | T3: tek Astra incelemesi → PR; karar bekleyenler aşağıda "T3 açıkları". Sonra T4 provider/model → T5 istem/ayarlar | `proof/TUI3-2026-10-07/` |
| TOPLU-DÜZELTME 2026-10-07 | Günlük toplu PR (owner 2026-10-07): iptal hatası `{missing}`, terminal "kullanılamıyor" i18n, `./extensions` types kapanışı, `/usage` ölçülmeyen değer, `/model` current işareti, wire10 gecikme dalı + alpha.9 sürüm artışı | `fix/batch-2026-10-07`: 7 madde + pack-smoke + belgeler; Astra incelemesi | Astra tek inceleme → merge → alpha.9 stage; canlı geçiş owner | `proof/BATCH-FIX-2026-10-07/` |
| EXT-SERVICE-ENTRY | `runtime serve` ve `deckent-mcp` dağıtımın `deckent/extensions`'lı girişinden açılsın; overlay servis ve MCP'de de görünsün | Kart adayı (kontrol oturumu notu 2026-10-07; ENTERPRISE-EXT KN2) | Kart; kanıt: aynı overlay operasyonu servis üzerinden ve MCP aracıyla. Kapanana kadar "Enterprise takılabilir" iddiası yok, uzantı kapısı yalnız CLI'da | `proof/W4-ENTERPRISE-EXT-2026-10-06/` |
| VLLM-CACHE-SALT | vLLM önbellek ayrım anahtarı (`cache_salt`) bugün kapsam adından deterministik sha256: gizli değil; aynı vLLM'i paylaşan iki kurulumda aynı kapsam adı aynı anahtarı üretir (vLLM güvenlik belgesi 2026-10-07: gizli, rastgele, kiracı sınırına bağlı olmalı; Astra 2423 not 4) | Main'de (dalga 4), yetenek opt-in, canlı N1 kullanmıyor; owner'a sorulmadan girdi, 2026-10-07 owner'a soruldu | **Owner 2026-10-07: HMAC(kurulum sırrı, scopeId)** (Jev d19835e0 0,97 / yeterlilik 0,67 → owner); uygulama toplu PR'da (`8421f56d`): ayrı 256 bit `prefix-cache-salt.key`, authority.key'den türetilmez; sır yoksa istek gitmez. Döndürme komutu yok. İnene kadar "Enterprise paylaşımlı vLLM'de müşteri ayrımı" iddiası yok | `proof/VLLM-CACHE-SALT-2026-10-07/` |
| BACKUP-COMMAND | Ürün komutu `deckent backup create/verify/restore`, servis zamanlaması + audit; authority.key kurtarma setinde operatör parolasıyla şifreli (scrypt+AEAD), KMS adaptörü sonra (owner 2026-10-07) | Kart açılmadı | Kart; N1 için tatbikat betikleri geçici | `proof/W4-S1-RECOVERY-2026-10-06/RUNBOOK.md` |
| CONFIG-GROWTH | N1 `config.json` 6 günde 127 KB → 1,96 MB (admission registry her kart türüyle büyüyor) | Gözlem (S1 tatbikatı) | Ölçüm + budama/ayırma kartı | `proof/W4-S1-RECOVERY-2026-10-06/` |
| IDENTITY-BINDING-V2 | Makine kimliği yokken taşınma koruması: yapılandırılabilir kaynak → /etc/machine-id → zayıf yol+cihaz+inode bağı; `installation.requireMachineBinding` (owner 2026-10-06) | Canlıda (alpha.7) | Rollback notu owner-decisions'ta | `proof/W2-BINDING-V2-2026-10-06/`; [owner-decisions](.deckent/docs/decisions/owner-decisions.md) |
| IDENTITY-PROFILES | Solo/ekip/enterprise/özel sürümlü kimlik profilleri (I0–I5), K1–K3 = A | I0 + I1 (profil registry + yetkisiz taslak önizleme) main'de (dalga 4) | I2 | `proof/IDENTITY-PROFILES-DESIGN-2026-10-05/design.md` |
| MODEL-INGRESS-UNICODE | Gizli Unicode: not/audit/karantina | P1+P2 canlıda (alpha.7) | P3 araç/MCP şema + argüman JSON (sonraki partinin ilk güvenlik işi) | [work-list](.deckent/docs/plan/work-list.md) |
| FLAKY-RECOVERY | Installed offline completion/cancellation | Kaynak indi | Gerçek Docker ile doğrulama | [work-list](.deckent/docs/plan/work-list.md) |
| CI-DEBT | Kalan CI hataları tek iş (ubuntu-only ruleset owner komutu) | Owner'ın ayrı Codex ajanı | Ajan STATUS çıktısını izle | `proof/CI-DEBT-2026-10-05/STATUS.md` |
| NODE-26 | Node 26 geçişi | Hedef LTS 2026-10-28 | O tarihte tam verify | owner-decisions |
| NATIVE-AGENTS | Owner öncelik #4 OpenCode, #5 Copilot CLI, #6 Kimi Code CLI, #7 Antigravity/Gemini | Hazırlanmadı | `commands.json` kayıtları + credential spec + imaj + usage kanıtı; Devin = ayrı remote-worker adaptörü | [hedefler](.deckent/docs/plan/owner-targets-2026-10-05.md) |
| MODEL-PROVIDERS | Owner öncelik #8 GLM, #9 DeepSeek | Hazırlanmadı | Katalog kaydı: `provider-openai-chat` veya `provider-openrouter-chat` | [hedefler](.deckent/docs/plan/owner-targets-2026-10-05.md) |
| SIWC | OpenAI "Sign in with ChatGPT" (PKCE OIDC, Responses API kapsamı) | Tasarım önce | Tasarım + uygunluk kartı | `proof/SUBSCRIPTION-LOGIN-2026-10-05/sources.md` |
| CLAUDE-API-KEY-TERMINAL | Native terminalde Claude, API anahtarıyla | Sonra test | Abonelik/claude.ai girişi yasak; yalnız değiştirilmemiş Claude Code worker | [hedefler](.deckent/docs/plan/owner-targets-2026-10-05.md) |
| COMPUTER-USE | Kendi computer-use katmanı (Cowork/Codex/Perplexity Computer sınıfı), masaüstü uygulama özelliği | Hazırlanmadı | DESKTOP-ARCH D1–D7 ile tasarım; ekran eylemi yönetilen etki, policy/onay korunur; dayanak DALGA-6 | [hedefler](.deckent/docs/plan/owner-targets-2026-10-05.md) |
| DESKTOP-ARCH | Masaüstü D1–D7: Electron 44 ↔ Tauri 2 ölçümü, Windows+WSL | O7-A2/A3 indi | Windows UI↔WSL köprü dilimi; terminal önce | [work-list](.deckent/docs/plan/work-list.md) |
| TERMINAL-CLOSE | Terminal O1–O7 kapanışı (terminal birimi 2000/2000 satır: sonraki terminal dilimi birimi bölmeyi gerektirir) | S02…R6 + S05 satır modu redaksiyonu + S09 salt okunur yönetim komutları indi (dalga 4) | Kalan dilimler analysis.md sırasıyla; 26 dilimlik kabul | `proof/TERMINAL-CLOSE-2026-10-03/analysis.md` |
| PARALLEL-ORCHESTRATION | 8+ paralel işçi, DAG özeti | P33/S2 + S3 grafik sınırı (256/1024/64) canlıda (alpha.8) | DAG özeti | [work-list](.deckent/docs/plan/work-list.md) |
| MONITOR | İnsan okur canlı izleme yüzeyi (v1+v1.1 indi; M2 worker anlatısı + teslim sütunu, M3 düşen testler canlıda, alpha.7) | Kalan: push akışı; PATCH_LIMIT sebebi kayıtlı değil | Patch-prepare reddi tipli makbuz kartı | [work-list](.deckent/docs/plan/work-list.md) |
| WORKER-GIT-PR | Host branch/PR akışı | Araç PR #5 ile indi | Ayrıca yetkili ilk gerçek worker patch → PR denemesi | [workstreams](.deckent/docs/plan/workstreams.md) |
| AOF-HANDOFF | Tipli devir + accepted-attempt Run notları | Kaynak adayı `edd2512a`+`378cc93e`; birleşik aday bağımsız kabulsüz | Lead entegrasyonu + exact aday incelemesi | `proof/AOF-HANDOFF-2026-10-03/review.md` |
| AOF-DECISION-PORT | Karar portu (ledger v46) | Main'de ve canlıda | Ücret tavanı, pending-intent uzlaştırma/retention | [work-list](.deckent/docs/plan/work-list.md) |
| CONFIG-SURFACE | Registry config yüzeyi | Main'de ve canlıda | Native/built binary kanıtı; restart akışı alpha.8'de (CONFIG-SURFACE-RESTART) | [work-list](.deckent/docs/plan/work-list.md) |
| HARDCODE-P1 | Sabit-kod ratchet borcu (19 grup) | A/B alt grupları kısmi aday | Kalan P1 grupları, bağımsız inceleme | [work-list](.deckent/docs/plan/work-list.md) |
| SECRET-REDACTOR (B7) | Gizli bilgi redaksiyonu | B7+S06+SAFE-APPROVAL-A1 indi | Bölünmüş sırlar, tüm yüzeylerin kapsamı | [work-list](.deckent/docs/plan/work-list.md) |
| DOGFOOD-STAGES / EXEC-RELEASE | Dogfood D4, S1 kapı kodu | DOGFOOD resmî OFF; D4 denemeleri N1'de | Owner izinli sınırlı denemeler | [work-list](.deckent/docs/plan/work-list.md) |
| Hazır kart girdileri | DALGA-1…6, NEXT-DEFECTS-W6, G31, LONG-LIVED-AGENTS, LEGAL-HOLD, LEGACY-CODES-RETIRE, HOST-RULES-CLEANUP, AUDIT-CHECKPOINT, REASONING-RETENTION, TUI-COMPLETION, S-API | Çoğu uygulanmadı | Lead/Jev sırasıyla kart açılışı | [work-list](.deckent/docs/plan/work-list.md) |

## Alan kimlikleri (arch.json `plan` bağları)

| ID | Kalıcı kapsam / kapanış beklentisi |
|---|---|
| FOUNDATION | Paket/katman/import, config, i18n, dosya düzeni ve boyut kapıları; yeni yüzeylere aynı kurallar. |
| CONTRACT | Ontoloji, sürümlü komut/sorgu/olay, görev grafiği ve tek geçiş sahibi; tüm yüzeylerde aynı anlam. |
| STORE | Transactional ledger, kapsam, migration/restore; DB adapter başına gerçek tutarlılık kanıtı. |
| SECURITY | Principal/policy/approval, secrets ve audit; Core güvenli, Enterprise kimlik/organizasyon eklentileri ayrı. |
| ISOLATION | Workspace ile sandbox ayrımı; worker yetkileri, kaynak çatışması ve canlı hedefe güvenli teslim. |
| EXECUTION | Kalıcı DAG/koşul/parallel join, runtime/recovery, kabulden sonra bağımlılığın açılması; belirsiz etkide kör tekrar yok. |
| PROVIDERS | Çoklu native model, kapasite, ücretli API bütçesi ve abonelik gerçek/simülasyon ayrımı; sessiz sağlayıcı ikamesi yok. |
| SURFACES | Ortak SDK/CLI/MCP; MCP client/server ve sonraki UI/API yüzeylerinde tipli sözleşme ve erişilebilirlik. |
| INSTALLATION | Basit kurulum, sürümlü profil/policy, paket/imaj doğrulaması, kurtarılabilir kurulum ve dağıtım. |
| IFS-E2E | Cloud ve Applications 10'da aynı iş operasyonunun scope/policy/approval/etki uzlaştırmasıyla kanıtı. |
| LANG | TS referansına karşı seçilmiş Go supervisor deneyi; toplam bakım/dağıtım/güvenilirlik kazancı olmadan geçiş yok. |
| DOGFOOD | Kararlı N ile izole N+1 geliştirme; kabul/kurtarma kanıtı, maliyet izlemi ve dış kurtarma yolu. |
| MEMORY | Kapsamlı kalıcı kayıt, revision/provenance, conflict journal, yetkili retrieval; sessiz silme yok, indeks kayıt otoritesinin yerine geçmez. |
| LEARNING | Doğrulanmış sonuç→routing/skill/model iyileştirmesi; bağımsız eval, provenance, geri dönüş. CORE-MODEL R1/R2 analizi ve kalan hukuk/consent kapıları [workstreams](.deckent/docs/plan/workstreams.md). |
| ASSURANCE | Yük/arıza/platform matrisi, backup/restore, sürüm yükseltme ve Core/Enterprise ayrı yayın kanıtı. |

## Açık P0/P1 bulgular

- **P0:** belgelenmiş açık P0 yok (2026-10-05).
- **P1 AOF-HANDOFF R1** (Astra 2300: platform yeteneği/taşınabilir testler): dar şeritte düzeltildi; birleşik aday için bağımsız kabul yok → [work-list](.deckent/docs/plan/work-list.md).
- **P1-benzeri güvenlik takibi MODEL-INGRESS-P3:** araç/MCP şema açıklaması ve argüman JSON'unda gizli Unicode; sonraki batch'in ilk güvenlik işi.
- **Dalga 2 takipleri** (lead kararları 2026-10-06): patch-prepare reddi tipli makbuz (`attempt_receipts`, ledger sürümü + göç); `LayoutError` insan metni (config dışı yüzeyler); **MARK-LOST-ATOMIC (owner 2026-10-06, takip kartı; Astra 2384):** `mark-lost` dalgadan çıkarıldı; kart: `unknown` gözlemi + Run hold'u tek işlemde, **KARAR 12 (lead/owner)** slot bırakma (tipli manuel inceleme/yerleşim kararı veya dispatch fence + sonlanma kanıtı), mühürlü audit, MCP aracı, kaybolan dispatch kaydı (#13); o zamana dek kaybolan deneme `active`, slot tutulu; CI'ya ayrı perf job; MODEL-INGRESS-P3 yukarıda. Ayrıntı [open-findings](.deckent/docs/plan/open-findings.md).
- Etiketsiz açıklar (SBOM gömülü kopya tespiti Astra 2192, SURROGATE-CUT sınırları, terminal/provider açıkları): [open-findings](.deckent/docs/plan/open-findings.md).

## Owner karar indeksi

Tam metinler [owner-decisions](.deckent/docs/decisions/owner-decisions.md) ve ARCHITECTURE [karar günlüğü](.deckent/docs/architecture/decisions.md)'ndedir.

- 2026-09-21 geliştirme dogfooding sırası, worker izin modu, onay, süre dolması → owner-decisions "Owner kararı — 2026-09-21".
- 2026-09-23 iki hat ve Enterprise katmanı (Core Apache-2.0; ERP adaptörleri registry ile) → owner-decisions + core-memory kanun 10.
- Kalıcı yön (müşteri-kurulumlu ürün, Task/Run/Mission, tek durum sahibi, TS Core) → owner-decisions "Kalıcı yön ve kararlar".
- 2026-09-22 modül yapısı kararı ve bitiş tahmini; legacy → Next envanteri → owner-decisions.
- 2026-09-24 terminal = Claude Code sınıfı ajan terminali; vLLM ayrı iş → [workstreams](.deckent/docs/plan/workstreams.md).
- 2026-09-27/28 terminal döngüsü, POLICY-ADMIN, eşzamanlılık slotu, M1 Hat B tasarımı → owner-decisions.
- 2026-09-29 izin modları, bağımlılık/platform (Node 24+26, zod 4, Apache-2.0) → owner-decisions.
- 2026-09-30 dogfood K1–K9, terminal/model-imaj güncelliği → owner-decisions.
- 2026-10-01 D1–D10 ve dalga 1–5 kararları → owner-decisions, [work-list](.deckent/docs/plan/work-list.md).
- 2026-10-02 MCP-NO-DECIDE, CONFIG-SURFACE, monitör görevi → [status notları](.deckent/docs/plan/status-2026-10-05.md), ARCHITECTURE.
- 2026-10-03 dalga 6 (WorkClass, kendi computer-use mekanizması, Slack+Discord), süreç panosu → [work-list](.deckent/docs/plan/work-list.md) (DALGA-6), core-memory.
- 2026-10-05 kimlik profilleri K1–K3 = A; Qwen host pilotu; NATIVE-AGENTS/MODEL-PROVIDERS/SIWC/CLAUDE-API-KEY-TERMINAL/COMPUTER-USE hedefleri → bu tablo, [qwen-host-pilot](.deckent/docs/plan/qwen-host-pilot.md).

- 2026-10-06 Qwen karar araştırması owner tarafından iptal edildi; native Qwen korunur, karar danışmanlığı mevcut Jev ile sürer. Kapanış: [COMPLETED-PLAN](COMPLETED-PLAN.md), dış proof `QWEN-CANCELED-2026-10-06/`.

- 2026-10-06 Jev host kullanım önerileri kabul edildi; soru tanılaması/yönerge, zaman sıralı follow-up raporu ve 20 farklı kaynaklı pilot uygulandı. Context genellemesi için kazanç kanıtlanmadı; kapanış ve sınırlar [COMPLETED-PLAN](COMPLETED-PLAN.md), dış `proof/JEV-HOST-HYGIENE-2026-10-06/REPORT.md`.

- 2026-10-07 günlük toplu düzeltme PR'ı (dalga = tek PR; main'i kıran düzeltme tek başına), yan/kontrol notları owner'a Türkçe, BACKUP-COMMAND, authority.key parolayla şifreli, satır modu yazma birimi = tamamlanmış satır, vLLM `cache_salt` = HMAC(kurulum sırrı, scopeId) → owner-decisions "Owner kararları — 2026-10-07".

- 2026-10-06 CI-LOCAL: `ci:local` ubuntu eşleniği, `precommit:fast`, `hooks:install`; CI-SPEED owner onayıyla `land:check` exact-SHA hosted Ubuntu24/26 sonucunu okur; eski yerel makbuz yolu `land:check:local` isteğe bağlıdır; pre-push yalnız `DECKENT_LANDING=1`; macOS/Windows kapsam dışı. Ayrıntı: ci-and-verification modül notu, dış `proof/CI-LOCAL-2026-10-06/`.
