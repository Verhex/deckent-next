# Deckent Next — ana plan

Bu dosya yalnız **devam eden işi** üç katmanda taşır: **Şimdi** (en çok 7 madde, beta kapısına bağlı), **Sıradaki** (karar verilmiş iş, sıralı) ve **Gelen kutusu** (haftalık triyajı bekleyen bulgular; bulgu otomatik iş değildir, Kanun 2). Yalnız güvenlik veya canlıyı bozan bulgu kuyruğu atlar. Beta kapısından önce owner açmadıkça yeni yüzey yok. Katmanlar: yalnız core (Deckent), enterprise, custom; baz/kullanıcı katmanı yok, ürünleşmeden önce yeniden katmanlama yok, paket tek bütün. Günlük sürüm treni: lead hazırlar, owner günde tek evet/hayır yanıtlar; sürüm kapısı = Astra PASS + hosted CI yeşil.

Eski 88 satırlı "Aktif iş alanları" tablosu, eski Şimdi ve P0/P1 maddeleri birebir [arşivde](.deckent/docs/plan/archive-2026-10-14.md) (owner 2026-10-14; hiçbir metin silinmedi). Tamamlananlar [COMPLETED-PLAN](COMPLETED-PLAN.md), owner kararları [owner-decisions](.deckent/docs/decisions/owner-decisions.md), iş ayrıntıları `.deckent/docs/plan/` altındadır. Kimde-ne-var: `node .agents/refactor/board.mjs show`; sözleşmeler [ARCHITECTURE](ARCHITECTURE.md).

**Gerçek durum (2026-10-14):** canlı + N1 = alpha.35 (`ef1aecda`, 2026-10-13 21:47Z). İlk canlı `/do` uçtan uca 2026-10-13 (Run `f42bae9d`), ilk tam teslim + benimseme 22:03Z (Run `1f29f85a` → `refs/heads/deckent/teslim`). alpha.36 adayı `wave/alpha36-2026-10-14` (PR #85 taslak): alpha.35 gerileme düzeltmesi, teslim/benimseme için doğrulanmış insan y/N + anlamlı commit, monitörde süresi dolan onay/para/Brain harcama satırı, terminal sabit giriş alanı + odak kuralı + aktif iş şeridi (Ctrl+T) + terminal teslim penceresi (`/deliver`, Ctrl+O + y). Roller: main Opus, bağımsız inceleme Astra (`gpt-6-astra`), lane'ler Sonnet 5.5, kritikte Opus; DOGFOOD ON (N1 = user systemd `deckent-n1.service`).

**Beta kapısı (öneri, owner onayı bekler):** (1) alpha.36 canlı ve owner terminali kabul eder; (2) S6 sır kapısı dispatch öncesi; (3) NATIVE-BAGLAM model çalışma bağlamı; (4) temiz makinede kurulum provası (init → /do → teslim, lead yardımsız); (5) main hosted CI yeşil; (6) bilinen sınırlar sayfası.

## Şimdi (en çok 7)

| İş | Neden | Durum | Sıradaki adım |
|---|---|---|---|
| alpha.36 canlıya + terminal kabulü | Kapı 1: owner terminali kabul etmeden beta yok | Aday `wave/alpha36-2026-10-14` (PR #85 taslak): TESLIM-GUVENLIK (doğrulanmış insan y/N + anlamlı commit), TERMINAL-SABIT R2 (sabit giriş, odak kuralı, aktif iş şeridi), terminal teslim penceresi, KUCUK-DUZELTMELER (onay expiry, para, Brain maliye satırı) | Astra PASS + hosted CI → canlı/N1 geçişi → owner terminal kabulü |
| S6 sır kapısı | Kapı 2: sır dispatch'ten önce kapıda durmalı | Karar var, kod yok | Kart aç, yazar lane; canlı-eşzamanlılık dilim 1–2 ile paralel |
| NATIVE-BAGLAM | Kapı 3: modelin çalışma bağlamı native çalışsın | Aday `feat/native-baglam-2026-10-14`: istem v10 oturum bağlamı (mod/düşünme/model/araç etkisi/yüzeyler/kurallar), `session_state` (politika izin verirse), aktif iş notu, satır içi `<think>` yönlendirme | Astra incelemesi; owner kararı: `session_state` için şablon v12 varsayılan izni |
| Temiz makine kurulum provası | Kapı 4: init → /do → teslim lead yardımsız | Başlamadı | WSL/Docker temiz kurulum senaryosu; BATCH-D-KALAN (Gelen kutusu) girdisi |
| Main hosted CI yeşil | Kapı 5: ubuntu node24+26 zorunlu hücreler | CI-DEBT (CI-ONARIM CARD-2) yazar adayı: açık MCP fixture izinleri, tipli hata/devir beklentileri; node 26 MCP bağlantı zaman aşımı nedeni bilinmiyor | alpha.36 hosted koşusu; CI değişikliği başına bir hosted deneme + bir düzeltme (owner 2026-10-06) |
| Bilinen sınırlar sayfası | Kapı 6: dürüst kapsam beyanı | Başlamadı | Gelen kutusu + açık P1 listesinden derle; README/docs bağı |

## Sıradaki (karar verildi; sıralı)

1. **S6 sır kapısı ∥ canlı-eşzamanlılık dilim 1–2** (ölçüm, kayıt boşlukları; KAYNAK-KALITE bounded iz + CPU/RAM inspect/monitor temelini kullanır)
2. **NATIVE-BAGLAM** ∥ **SIWC-CORE** (owner 2026-10-14: ücretsiz Apache-2.0 Core'da kendi ChatGPT hesabıyla resmî Sign in with ChatGPT; brief `.deckent/host/handoffs/SIWC-CORE-2026-10-14/implementation-brief.md`; Codex yazar lane) ∥ **KOMUT-BIRLESTIRME** analizi (owner 2026-10-14: terminal/CLI izleme-görme-onay komutlarının tekilleştirilmesi; iş listesinde bekleyen komutlar, ör. `/compact`, aynı pakette)
3. **Atama**: WorkClass → model/effort (sistem atar, Brain atamaz), Brain frontier sınıfı + **M5-D4** ajan/skill kademeleri + başarı defteri (ABONELIK-API-YONLENDIRME D2+ aday listesi, billing ekseni, anahtarsız API worker; owner kararları 2026-10-13)
4. **Headless CLI abonelik Brain** (Brain abonelik; M5-D5 sürer)
5. **Test azaltma M1** (+ ağaç-hash test makbuzu, host test servisi, etkilenen seçimi — gölge modda; güvenlik/negatif testler zayıflatılmaz)
6. **Otonom teslim kuralları** (DONGU-KAPATMA kalanı; owner teslim/benimseme kuralları)
7. **Eşzamanlılık dilim 4–10** (salt okunur operasyon yolu, aktif iş görünümü, okuma-seti kaydı, teslim anı yeniden doğrulama, merge-tree + birleşik doğrulama, audit olayları, ölçülürse serileştirme)
8. **KATMAN-ETKIN** (custom katman kanıtı)
9. **POLITIKA-MODULU P1–P5** (P0 alpha.35'te indi; P1 kurucu admin + kartlı kurtarma, P2 iki gerçek kişiyle devir, P3 rol düzenleme, P4 imzalı paket, P5 Enterprise merkez)
10. **Masaüstü** (beta sonrası, owner açar; DESKTOP-ARCH Electron + React, ayrı depo `deckent-desktop`).

Yan analizler (ultracode oturumu; `proof/ANALIZ-*-2026-10-14/PROMPT.md`, sonuç lead'e döner): ATAMA-TIER, HEADLESS-BRAIN, TEST-AZALTMA, OTONOM-TESTLIM, TERMINAL-UX.

**Sıralanmamış (karar var, sıra yok; tam metin arşivde):** M5-D3 onarım, M5-D5 Brain/Auditor devamı, M5-D6 hafıza, M5-D7 Nervous, M5-D8 (ertelendi), M5-RECORD (iz/spool/saklama katmanları), M5-AGENT-TYPES, M5-AGENT-DEF, CONTINUATION-ARTIFACT, RUN-SPEND-CEILING (API worker bütçe tasarımı owner'a), PROVIDER-SPEND-LIMITS, COST-GUARDS onay eşiği, CACHE-SLICE2, LLMTR, SECRET-CONTINUITY, DECKENT-MD-WORKERS, PROTECTED-PATHS, MCP-OAUTH, FIRECRACKER-REALM, NPM-PUBLISH (ürün kararlı olunca), NODE-26 (hedef LTS 2026-10-28), NATIVE-AGENTS, SIWC, COMPUTER-USE. Görev düzelt-yeniden dene yapısı ileride gündeme gelir (owner 2026-10-12; otomatik tekrar yok).

## Gelen kutusu (haftalık triyaj; iş değil, bulgu)

Kural: bulgu triyajda sıraya ya da arşive gider; yalnız güvenlik/canlıyı bozan bulgu hemen kuyruğu atlar. Tam eski satırlar [arşivde](.deckent/docs/plan/archive-2026-10-14.md) "Gelen kutusu" bölümünde.

- **İlk canlı /do kırılma noktaları (2026-10-13/14, `proof/DO-UCTAN-UCA-N1-2026-10-13/KIRILMA-NOKTALARI.md`):** run-create kartı alanları (risk/geri alma/kural "araç bildirmedi"); needs-input cevabı terminalden (WORKER-NEEDS-INPUT); reasoning kapalıyken QUERY_UNEXPECTED_FAILURE; bayat checkout koruması; 72 minör tutulan rezervasyonun uzlaştırılması; /do kartı TTL 10 dk; CLI `do` onaydan sonra devam etmiyor.
- **Belge kayması:** DOGFOOD-PARALLEL-DELIVERY açık görünüyordu ama alpha.25'te indi (arşive taşındı).
- **Kod borçları (arşiv satırları):** BATCH-D-KALAN (WSL/Windows kabulü), E2-LAW-DEBT, F-LAW-DEBT, EXT-REGISTRATION-VERSIONING (Kanun 10), REDACT-LONG-ATOM-MARKER, SANDBOX-AUTHORITY-FOLLOWUPS, TERM-TEST-FIXES (B4 kök neden), MCP-REDIRECT, EFFECT-FENCE-PROVENANCE, PACKAGE-SPLIT (beta sonrası), CONFIG-GROWTH, CONFIG-SOURCE-DECISION, HARDCODE-P1, N1-VERIFY-EXCLUSIONS-V13, MONITOR kalanı (push akışı, PATCH_LIMIT sebebi), DELIVERY-GATE-SCOPE, KANUN-8-GUNCELLEME (owner onayı bekler).
- **Açık P1/P0 listesi:** aşağıda.

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
| AOF-HANDOFF | Tipli devir + accepted-attempt Run notları; main'de ve canlıda (arşiv). |
| AOF-DECISION-PORT | Karar portu (ledger v46); main'de ve canlıda. |
| CONFIG-SURFACE | Registry config yüzeyi; main'de ve canlıda. |
| HARDCODE-P1 | Sabit-kod ratchet borcu (19 grup); Gelen kutusu. |
| KAYNAK-KALITE | Worker kaynak/maliyet/kalite: bounded yerel iz, CPU/RAM inspect/monitor, Run maliyet/kabul raporu, saf öneri motoru; Sıradaki 1'e bağlı. |
| SECRET-REDACTOR (B7) | Gizli bilgi redaksiyonu; B7 + S06 + SAFE-APPROVAL-A1 indi, REDACT-LONG-ATOM-MARKER Gelen kutusunda. |
| M5-D5 Brain ve Auditor | `/do` → RunProposal, Mission turları, A-1 LLM'siz assurance_ev; Brain/Auditor devamı (Sıradaki 3–4); tam eski satır arşivde. |
| MONITOR | İnsan okur canlı izleme yüzeyi (v1+v1.1 indi); kalan Gelen kutusunda. |

## Açık P0/P1 bulgular

Eski tam metinler arşivde ("Eski Açık P0/P1 bulgular").

- **P0:** belgelenmiş açık P0 yok (2026-10-10: sağlayıcı denetimi 0 P0; Astra 2493 yeni P0/P1 yok).
- **P1 RESTART-RECOVERY (W11):** bağımsız inceleme, entegrasyon ve gerçek container öldürme + servis restart kabulü yok; kayıp worker `unknown` hold'u MARK-LOST-ATOMIC kararına bağlı.
- **Sağlayıcı denetimi P1'leri** (W6, `1c602d94`, 0 P0 / 10 P1 / 14 P2): çoğu alpha.23'te indi; kalanlar (A04/A05 Z.ai parser, A08 thinking-off seçimi, MODEL-STATE-PARITY/BUDGET-HOLD parçaları) arşivdeki metinden izlenir.
- **SANDBOX-HOME-WALK:** bağımsız inceleme ve birleşik/hosted kabul açıktı; alpha.26+ içinde indi, kapanış doğrulaması arşiv metninde.
- **OPENROUTER-GATE (owner ön koşulu):** ilk ücretli OpenRouter çağrısından önce "Prevent overrides" eklentisi yok ve OpenRouter kredi limiti Deckent bütçesinden yüksek değil.
- **MODEL-INGRESS-P3:** native worker'ın kendi araçları Deckent giriş yolunun dışında.
- **Dalga 2 takipleri:** patch-prepare reddi tipli makbuz, `LayoutError` insan metni, MARK-LOST-ATOMIC (KARAR 12).
- Etiketsiz açıklar (SBOM gömülü kopya, SURROGATE-CUT sınırları, terminal/provider): [open-findings](.deckent/docs/plan/open-findings.md).

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

- 2026-10-08 harcama kesinleştirme, fiyat, OpenRouter/LLMTR/DECKENT-MD, sağlayıcı sınırları, beta 2026-10-11 → owner-decisions "Owner kararları — 2026-10-08 (harcama kesinleştirme, fiyat, sağlayıcılar, beta)", ilgili PLAN satırları.

- 2026-10-09/10 DOGFOOD onayı (10-09) ve DOGFOOD ON (10-10 01:17Z, ilk benimseme `8208517a`); DESKTOP-ARCH D1 = Electron + React (10-09); paket bütçeleri geçici composition 7200 / adapters 28000, bölünme beta sonrası (owner 2026-10-11; önceki 6700/26300 sınırı 10-09, 10-10'da batch E bu sınırda bölündü); Jev eşikleri 0,85/0,67 (Teslim düzeni); lead tek yetkili (10-10, geri alınana kadar); `follow-up-works/current-flow.md` kısa süreli görev hafızası, biten iş silinir (10-10) → [karar günlüğü](.deckent/docs/architecture/decisions.md), internal contract.

- 2026-10-06 CI-LOCAL: `ci:local` ubuntu eşleniği, `precommit:fast`, `hooks:install`; CI-SPEED owner onayıyla `land:check` exact-SHA hosted Ubuntu24/26 sonucunu okur; eski yerel makbuz yolu `land:check:local` isteğe bağlıdır; pre-push yalnız `DECKENT_LANDING=1`; macOS/Windows kapsam dışı. Ayrıntı: ci-and-verification modül notu, dış `proof/CI-LOCAL-2026-10-06/`.

- API worker bütçesi tasarımı (owner 2026-10-12): Run başına yürütme boyunca toplam harcama sınırı, rezervasyona Run/Attempt kaynağı, owner'a tasarım olarak gelecek.
- Kaynak ölçümü yük pilotu (alpha.31 sonrası): toplayıcı açık/kapalı yük karşılaştırması, gerçek Docker CPU/RAM kabulü, iz deposunun sınırlı segmentlerle ekleme yapısı yapıldı (yazar adayı; yük pilotu açık); ardından geçici sınırlar ölçümle sabitlenir (K-F S8). Karşılaştırma pilotu: yalnız N1 dogfood, abonelik ve yerel modeller (owner 2026-10-12).
- Görev düzeltme/yeniden deneme yapısı (owner 2026-10-12): başarısız (hata olmayan) görevde agent'ın görevi doğru tamamlaması ve bağımlılık zincirinin sarsılmaması için düzelt-yeniden dene yapısı ileride yeniden gündeme gelecek (deckent-dev'de en çok 3 tekrar vardı; bugünkü karar: otomatik tekrar yok, owner AUTORETRY operator_only_default 2026-10-01). Tasarım owner'a sunulacak; şimdilik uygulanmaz.
