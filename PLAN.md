# Deckent Next — ana plan

Bu dosya yalnız **devam eden işi** üç katmanda taşır: **Şimdi** (en çok 7 madde, beta kapısına bağlı), **Sıradaki** (karar verilmiş iş, sıralı) ve **Gelen kutusu** (haftalık triyajı bekleyen bulgular; bulgu otomatik iş değildir, Kanun 2). Yalnız güvenlik veya canlıyı bozan bulgu kuyruğu atlar. Beta kapısından önce owner açmadıkça yeni yüzey yok. Katmanlar: yalnız core (Deckent), enterprise, custom; baz/kullanıcı katmanı yok, ürünleşmeden önce yeniden katmanlama yok, paket tek bütün. Günlük sürüm treni: lead hazırlar, owner günde tek evet/hayır yanıtlar; sürüm kapısı = Astra PASS + hosted CI yeşil.

Eski 88 satırlı "Aktif iş alanları" tablosu, eski Şimdi ve P0/P1 maddeleri birebir [arşivde](.deckent/docs/plan/archive-2026-10-14.md) (owner 2026-10-14; hiçbir metin silinmedi). Tamamlananlar [COMPLETED-PLAN](COMPLETED-PLAN.md), owner kararları [owner-decisions](.deckent/docs/decisions/owner-decisions.md), iş ayrıntıları `.deckent/docs/plan/` altındadır. Kimde-ne-var: `node .agents/refactor/board.mjs show`; sözleşmeler [ARCHITECTURE](ARCHITECTURE.md).

**Gerçek durum (2026-10-14):** canlı + N1 = alpha.38 (`7eba8b1f`, 2026-10-14 17:03Z; CI-KARARLILIK: servis başlarken kimlik, geri yükleme, saat izlemeli kabuk yazma kümeleri). alpha.36 (`c9b36b7c`, 09:38Z) ve alpha.37 (`efb2a5b9`, 12:18Z, Ctrl+Y düzeltmesi; owner'ın tek seferlik CI istisnasıyla) indi; hosted CI kapısı yeniden katı (PR #87 ve main yeşil, 2026-10-14). İlk canlı `/do` uçtan uca 2026-10-13 (Run `f42bae9d`), ilk tam teslim + benimseme 22:03Z (Run `1f29f85a` → `refs/heads/deckent/teslim`). Roller: main Opus, bağımsız inceleme Astra (`gpt-6-astra`), lane'ler Sonnet 5.5, kritikte Opus; DOGFOOD ON (N1 = user systemd `deckent-n1.service`).

**Beta kapısı (öneri, owner onayı bekler):** (1) owner terminalde alpha.36+ davranışını kabul eder: owner denemesini bekliyor; (2) S6 sır kapısı dispatch öncesi: worker'da; (3) NATIVE-BAGLAM model çalışma bağlamı: worker'da; (4) temiz makinede kurulum provası (init → /do → teslim, lead yardımsız): başlamadı; (5) main hosted CI yeşil: yapıldı 2026-10-14 (`7eba8b1f`); (6) bilinen sınırlar sayfası: bu kart (`docs/known-limits.md`); (7) owner 2026-10-11 kararı: test-ERP kanıtları canlıda gözlenince ([owner-decisions](.deckent/docs/decisions/owner-decisions.md) "Sürüm sırası", satır 389): canlıda gözlem kaydı yok, kanıt yalnız fixture/test (alpha.28/29), gözlem koşusu planlanmadı.

## Şimdi (en çok 7)

| İş | Neden | Durum | Sıradaki adım |
|---|---|---|---|
| Terminal kabulü | Kapı 1: owner terminali kabul etmeden beta yok | alpha.38 canlıda; kabul owner'ın denemesini bekliyor | Owner denemesi; bulgu çıkarsa Gelen kutusu |
| S6 sır kapısı | Kapı 2: sır dispatch'ten önce kapıda durmalı | Worker'da (karar var) | Yazar lane teslimi → Astra |
| NATIVE-BAGLAM | Kapı 3: modelin çalışma bağlamı native çalışsın | Worker'da (karar var) | Yazar lane teslimi → Astra |
| Temiz makine kurulum provası | Kapı 4: init → /do → teslim lead yardımsız | Başlamadı | WSL/Docker temiz kurulum senaryosu; BATCH-D-KALAN (Gelen kutusu) girdisi |
| Bilinen sınırlar sayfası | Kapı 6: dürüst kapsam beyanı | Bu kart: `docs/known-limits.md` + `.tr.md` + README/mimari bağları | Astra/owner okuması; her sürümde Honest limits ile eşleme |
| Test-ERP canlı gözlem | Kapı 7: owner 2026-10-11 kararı | Canlıda gözlem kaydı yok (fixture/test kanıtı var) | Gözlem koşusu tasarlanır; owner kapı listesini onaylarken karar verir |

## Sıradaki (karar verildi; sıralı)

0. **Kuyruğu atlayan güvenlik kartları:** MCP-GUVENLIK G2 (salt okunur MCP aracı yapılandırmayı onarmamalı) ve G3 (terminal yeniden onayı CLI "her zaman sor" kilitlerini silmemeli). G1 (MCP = AI aktörü, politika hücreleri, hold→resume aklama) ONAY-GUVENCE analizinden sonra owner Y3/Y4 bekler (owner yönü 2026-10-14: MCP trafiği her zaman AI; AI, insan adımlarını yalnız politikayla devralır).
1. **S6 sır kapısı ∥ canlı-eşzamanlılık dilim 1–2** (ölçüm, kayıt boşlukları; KAYNAK-KALITE bounded iz + CPU/RAM inspect/monitor temelini kullanır)
2. **NATIVE-BAGLAM** ∥ **SIWC-CORE** (owner 2026-10-14: ücretsiz Apache-2.0 Core'da kendi ChatGPT hesabıyla resmî Sign in with ChatGPT; brief `.deckent/host/handoffs/SIWC-CORE-2026-10-14/implementation-brief.md`; Codex yazar lane) ∥ **KOMUT-BIRLESTIRME** (owner 2026-10-14: terminal/CLI izleme-görme-onay komutlarının tekilleştirilmesi; `/compact` gibi bekleyen komutlar aynı pakette)
3. **Beta öncesi, owner seti 4 (2026-10-14):** (a) terminal hold/resume + doğrulama-Run benimseme anahtarları (kabul/ret, bekleyen Y3'ü izler); (b) SDK yalnız yönetilen: ham yazıcılar bir sonraki sürümlü SDK sözleşmesinde dışa aktarımdan çıkar, yönetilen config yazımı önce gelir; (c) belirsiz (doğrulanamayan) ERP yazımını Core'da insan beyanıyla kapatma: ayrı terminal durumu, kanıt eki zorunlu, kabul kanıtı sayılmaz, arayüzü beta sonrası. `deckent operation list` beta sonrası; README beta.1'de sınırı yazar.
4. **Atama**: WorkClass → model/effort (sistem atar, Brain atamaz), Brain frontier sınıfı + **M5-D4** ajan/skill kademeleri + başarı defteri (ABONELIK-API-YONLENDIRME D2+ aday listesi, billing ekseni, anahtarsız API worker; owner kararları 2026-10-13)
5. **Headless CLI abonelik Brain** (Brain abonelik; M5-D5 sürer)
6. **Test azaltma M1** (+ ağaç-hash test makbuzu, host test servisi, etkilenen seçimi, gölge mod; güvenlik/negatif testler zayıflatılmaz)
7. **Otonom teslim kuralları** (DONGU-KAPATMA kalanı; owner teslim/benimseme kuralları)
8. **Eşzamanlılık dilim 4–10** (salt okunur operasyon yolu, aktif iş görünümü, okuma-seti kaydı, teslim anı yeniden doğrulama, merge-tree + birleşik doğrulama, audit olayları, ölçülürse serileştirme)
9. **KATMAN-ETKIN** (custom katman kanıtı)
10. **POLITIKA-MODULU P1–P5** (P0 alpha.35'te indi; P1 kurucu admin + kartlı kurtarma, P2 iki gerçek kişiyle devir, P3 rol düzenleme, P4 imzalı paket, P5 Enterprise merkez)
11. **NPM-PUBLISH** (owner 2026-10-14): beta'da npm'e dist-tag'lerle yayın (`beta`, sonra `latest`).
12. **Masaüstü + ajan organizasyonu** (beta sonrası, owner açar): DESKTOP-ARCH Electron + React (ayrı depo `deckent-desktop`); ajan tanımları, skill'ler, tanım başına çok worker, başarı metrikleri, sınırlı evrim. Analiz AJAN-ORG-DESKTOP sürüyor (`proof/ANALIZ-AJAN-ORG-DESKTOP-2026-10-14`).

Yan analizler (ultracode oturumu; `proof/ANALIZ-*-2026-10-14/`, sonuç lead'e döner): TERMINAL-UX, ATAMA-TIER, HEADLESS-BRAIN, TEST-AZALTMA, OTONOM-TESLIM, SIWC-N0, ABONELIK-LIMIT, CLAUDE-KIMLIK, ACIK-BULGU-DURUM, YUZEY-UYUM, MUSTERI-YOLCULUK bitti; ONAY-GUVENCE ve AJAN-ORG-DESKTOP sürüyor.

**Sıralanmamış (karar var, sıra yok; tam metin arşivde):** M5-D3 onarım, M5-D5 Brain/Auditor devamı, M5-D6 hafıza, M5-D7 Nervous, M5-D8 (ertelendi), M5-RECORD (iz/spool/saklama katmanları), M5-AGENT-TYPES, M5-AGENT-DEF, CONTINUATION-ARTIFACT, RUN-SPEND-CEILING (API worker bütçe tasarımı owner'a), PROVIDER-SPEND-LIMITS, COST-GUARDS onay eşiği, CACHE-SLICE2, LLMTR, SECRET-CONTINUITY, DECKENT-MD-WORKERS, PROTECTED-PATHS, MCP-OAUTH, FIRECRACKER-REALM, NODE-26 (hedef LTS 2026-10-28), NATIVE-AGENTS, SIWC, COMPUTER-USE. Görev düzelt-yeniden dene yapısı ileride gündeme gelir (owner 2026-10-12; otomatik tekrar yok).

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
