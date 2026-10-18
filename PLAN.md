# Deckent Next — ana plan

Bu dosya devam eden işi üç katmanda taşır: **Şimdi** (en çok yedi beta grubu), **Sıradaki** (owner kararlarıyla sıralı iş) ve **Gelen kutusu** (haftalık triyaj; bulgu otomatik iş değildir). Yalnız güvenlik veya canlıyı bozan bulgu kuyruğu atlar. Beta öncesi yeni yüzeyi owner açar; Y1 ve ONAY-GUVENCE D0–D3 bu kapsamdadır. Katmanlar core (Deckent), enterprise, custom; tek bütün ürün/tek sürüm, ürünleşmeden yeniden katmanlama yok.

**Owner yönü 2026-10-15:** yeni araştırma konusu yok; verilen hiçbir karar plansız kalmaz. Önce beta kapısı işleri → owner denemesi → beta.1 (2026-10-18: kalan kod alpha.46 tek paketinde, sonrası yalnız kanıt). Beta ağırlıkla dogfood; npm beta geçişinde `beta`, kararlıda `latest`. Masaüstü ve ajan organizasyonu geliştirmesi beta sonrasında; ilk statik tıklanabilir tasarımlar önce hazırlanabilir. **Genel tanıtım hızlı ve güçlü, owner'ın kabul ettiği masaüstünü bekler.**

Ayrıntılı sıra, dilimler, bağımlılıklar ve açık sorular [2026-10-15 yol haritasında](.deckent/docs/plan/roadmap-2026-10-15.md). Önceki PLAN metni bağlantıları taşınan konuma uyarlanarak [arşivde](.deckent/docs/plan/archive-2026-10-14.md); tamamlanan iş [COMPLETED-PLAN](COMPLETED-PLAN.md), karar [owner-decisions](.deckent/docs/decisions/owner-decisions.md), sözleşme [ARCHITECTURE](ARCHITECTURE.md). Kimde-ne-var host panosunda; karar→plan eşlemesi ve kaynak snapshot'ı dış `proof/PLAN-UZLASMA-2026-10-15/` içindedir. Bu belge uygulama veya yeni yürütme izni değildir.

**Son saklanan sürüm kaydı:** alpha.38 `7eba8b1f`, 2026-10-14 17:03Z canlı/N1 sağlık kaydı; PR #87 ve main hosted CI yeşil, alpha.37 tek seferlik istisnası bitmiş. İlk canlı `/do` ve ilk teslim/benimseme 10-13 kayıtlarında. Bu belge çalışmasında canlı/N1 yeniden doğrulanmadı. Günlük paket: exact aday Astra PASS + hosted CI yeşil → owner'ın tek sürüm kararı; insan gerektiren adım owner'da, yazar kontrolü bağımsız PASS değil.

**Beta kapısı (yedi koşul; beta kabulü verilmedi):** (1) owner terminal kabulü; (2) dispatch öncesi S6; (3) NATIVE-BAGLAM; (4) temiz makinede init→/do→teslim provası; (5) exact sürüm adayında main/hosted CI yeşil; (6) dürüst bilinen sınırlar/README; (7) N1 devir ve test-ERP kanıtlarının canlı gözlemi (owner 10-11). 5'in alpha.38 tarihsel yeşili gelecekteki adaya taşınmaz; 7 fixture kanıtıyla kapanmaz. Aşağıdaki gruplar bu kapıların açılmış ön işlerini içerir.

## Şimdi (en çok 7)

**İndi (kayıt, iş değil):** alpha.39 kapı kodlarını çıkardı: S6 sır kapısı, NATIVE-BAGLAM, MCP AI aktörü + taban, denetim kontrol noktaları, /runs tuşları (Y1), ilk registry, ücret ekseni. alpha.43 teslim kuyruğunu, alpha.44 defter v58 + crash-loop breaker'ı, alpha.45 sistem-kıskaçlı plan tavanını getirdi (PR #99 main'de). Bunların kabulü aşağıdaki kanıt satırlarındadır; kod inmesi kabul değildir.

| İş grubu | Neden / beta bağı | Durum | Sıradaki adım |
|---|---|---|---|
| alpha.46 = beta adayı paketi | Owner kararı 2026-10-18: kalan beta öncesi kod tek pakette | Hazırlanıyor: plan izinlerini sistem türetir; S6 bağımlılık sınıfı + geçici node_modules istisnasının kaldırılması; küçük düzeltmeler | Paket → exact aday; bundan sonra beta öncesi yeni kod yok, yalnız kanıt |
| N1 50 görev + temiz kurulum provası | Kapı 4; lead yardımı/elle JSON olmadan init→/do→teslim | Açık; yalnız kanıt işi | N1'de 50 gerçek görev; temiz WSL/Docker tam yolculuk + geri alma |
| Owner terminal denemesi | Kapı 1; /runs tuşları, /deliver, kuyruk benimseme | Owner denemesini bekler | Hedefli kanıt → owner denemesi |
| Test-ERP / N1 devir canlı gözlemi | Kapı 7; fixture gerçek iş kabulü değil | Açık; canlı gözlem | Gerçek devir gözlemi ve sonuç kaydı |
| Exact aday: tam test + Astra + hosted CI | Kapı 5; alpha.38 tarihsel yeşili taşınmaz | alpha.46 adayı bekler | Tam test + Astra PASS + hosted CI yeşil → owner beta kararı |
| K1–K8 komut sadeleştirme (beta işi, paralel) | Betayla birlikte açılan komut birleştirme | Ayrı dalda başladı; betaya kadar canlı değil | Dal ilerler; canlıya yalnız beta kararından sonra |
| Betaya taşındı (owner 2026-10-18) | Beta öncesi kod paketinde değil | SIWC (ChatGPT ile giriş) görünürlüğü, Y3 onay kanalı, Y4 taban, D3 uzak karar tasarımı | Beta sürecinde; bilinen sınırlarda "beta sürecinde" yazılıdır |

Yeni sabit lane/worker sayısı yok. Ayrıntılar [beta öncesi](.deckent/docs/plan/roadmap-2026-10-15.md#beta-oncesi) ve [güvence](.deckent/docs/plan/roadmap-2026-10-15.md#guvence) bölümlerinde.

## Sıradaki (karar verildi; sıralı)

1. **Beta.1 → dogfood ağırlıklı beta:** yedi koşul ve owner kabulü; yayımlama tarihi uydurulmaz. alpha.46 = beta adayı (owner 2026-10-18); sonrası yalnız kanıt.
2. **NPM-PUBLISH:** hazırlık beta öncesi, yayın beta geçişinde `beta`, kararlıda `latest`; isim/scope/paket sayısının açık kalan kararı korunur.
3. **Masaüstü + ajan organizasyonu:** beta sonrası, tanıtım kapısı. §8'deki 17 dilim; ilk karne/havuz/olay akışı, desktop 4'ten itibaren bağımlılıkla; altı owner sorusu **açık**. **POST-BETA-PRODUCTIZATION-COMPARISON** (owner 2026-10-15): Paperclip/Hermes karşılaştırmasıyla Desktop yönetimi, hızlı onboarding, entegrasyon ömrü, çıktı inceleme ve insan yükü A0–A7 aşamaları; ilk adım güncel kaynak/boşluk matrisi → AL/UYARLA/ALMA → kabul kanıtlı dilimler ([brief](.deckent/docs/plan/post-beta-productization-paperclip-hermes.md)).
4. **ATAMA + HEADLESS-BRAIN:** sistem WorkClass→model/effort atar, Brain frontier; agent/skill tier, başarı defteri. Headless abonelik Brain **zorunlu**; N2-0, tier, kimlik ve H5 ölçüm tavanı bağımlılıkları.
5. **TEST-AZALTMA + OTONOM-TESLIM:** ölçüm→ortak fixture→gölge makbuz/seçim; güvenlik/negatifler korunur. Teslim önce gölge; owner'ın dar dogfood kuralı dışında y/N, adopt/rollback hep y/N.
6. **Eşzamanlılık:** 1–2 ölçüm/kayıt, S6 (kapı kodu alpha.39'da indi; bağımlılık sınıfı alpha.46'da); ardından 4→{5,6}→7→8→9→ölçüm gerektirirse 10. Veri maskeleme yöntemi Enterprise tamamlandıktan sonra ayrı süreç.
7. **POLITIKA-MODULU P1–P5 + güvence** (Y3 onay kanalı, Y4 taban, D3 uzak karar tasarımı betaya taşındı, owner 2026-10-18): iki gerçek kişiyle devir, rol/signed bundle/Enterprise merkez; D4 FIDO2, D5 imzalı paket (OG7), OG5 önce host hijyeni ölçümü sonra tam ayrım. Varsayılan zorunlu dokunuş yok; kurtarma+backup anahtar önkoşulu korunur.
8. **ABONELIK-LIMIT L1–L9:** L0=N2-0 ortak ödeme ekseni; kişi/limit/zamanlı başlangıç/kota; API geçişi kart+varsayılan kapalı kişisel tercih+bildirim. L3 kişi yalıtım tasarımı owner'la konuşulur.
9. **KOMUT-BIRLESTIRME + TERMINAL-UX kapanışı:** K1–K8 beta işi olarak ayrı dalda paralel başladı, betaya kadar canlı değil; S0–S8 tek paket; /runs,/compact,/deliver, needs-input, hareket/odak/tuşlar; fiziksel ölçüm sorumluluğu U5'e göre.
10. **YUZEY-UYUM ve MUSTERI-YOLCULUK kalanı:** S4–S12 bağımlılıkla (G1–G3/Y1 öne alındı); müşteri dilim 3–8. SDK **Y2 yalnız yönetilen yol**, M3 operation list beta sonrası ilk ERP kartı; M4 Core insan beyanı ayrı son durum/kanıt eki, UI sonra.
11. **Claude kimlik yolu:** owner a–d için Hiçbiri dedi, kendi analizini bekler. H4 taşıması aşılmıştır; mevcut yol doğrulanmış ikameyle aynı dilimde değişir, worker kesilmez. Diğer açık/M5/custom/bütçe işleri yol haritasındaki korunmuş kuyrukta.
12. **DOSYA-BOYUT-OLCU (beta, owner 2026-10-18):** satır ölçüsü uzun satırlarla aşılıyor (src'de 200+ karakter 1416 satır). Önce mimari kontrole dosya bayt bütçesi, satır uzunluğu sınırı, fonksiyon uzunluğu ve bağımlılık sayısı ölçüleri mevcut durumda kilitlenir; sonra sırayla bölme: `errors/registry.ts` (95 KB) alan başına, `i18n/*/cli.json` (1493/1500) bölüm başına, `composition/agent-turn/turn.ts` (42 KB) iş mantığı sahip birime; ardından `cli-terminal/terminal.ts`, `monitor/view.ts`, `native-connection/worker.ts`.
13. **HARNESS-FARK (owner 2026-10-18, kaynak proof/HARNESS-GAP-2026-10-18):** alpha.46'ya giren hızlı kazanımlar: kalıcı bağlam göstergesi, taslak saklama, yazı geri alma, geçmiş arama/istem atlama, teslim penceresinde salt okunur fark. **Beta:** görsel/pano eki, uzun istem için harici editör, oturum adlandırma/süzme, terminal dışı bildirim, yanıt stili, sohbet kopyala/dışa aktar, kuyruktaki mesajı düzenleme/yön verme, modelin seçenekli soru sorma aracı (ask-user motor sözleşmesi). **Sonra:** plan modu (`/plan` ayrılmış), oturum çatallama, checkpoint/geri sarma (dış etkiler telafi semantiği ister), hook'lar (yeni güven yüzeyi), sohbet alt ajanları, yapılacaklar listesi, tuş yeniden eşleme/Vim.

Bu liste gerçek bağımlılıkla yürür; güvenlik/live kırılması öne geçer, analiz önerisi otomatik admission olmaz. Ayrıntı ve tüm karar kimlikleri [yol haritasında](.deckent/docs/plan/roadmap-2026-10-15.md). Altı ajan-organizasyon sorusu, H5 tavanı, KC ayrıntısı ve Claude kimliği [açık girdilerdir](.deckent/docs/plan/roadmap-2026-10-15.md#acik-sorular).

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
| KAYNAK-KALITE | Worker kaynak/maliyet/kalite: bounded yerel iz, CPU/RAM inspect/monitor, Run maliyet/kabul raporu, saf öneri motoru; yol haritası Ölçüm/Eşzamanlılık işine bağlı. |
| SECRET-REDACTOR (B7) | Gizli bilgi redaksiyonu; B7 + S06 + SAFE-APPROVAL-A1 indi, REDACT-LONG-ATOM-MARKER Gelen kutusunda. |
| M5-D5 Brain ve Auditor | `/do` → RunProposal, Mission turları, A-1 LLM'siz assurance_ev; Brain/Auditor devamı (yol haritası M5/Headless); tam eski satır arşivde. |
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


2026-10-11–15 karar eki [owner-decisions](.deckent/docs/decisions/owner-decisions.md) içindedir. A1–A8/H1–H6/K1–K8/O1–O6/T3–T4/S1–S8, U1–U5/B1–B3/L-A–L-E, Y1–Y4/M3–M4/OG1–OG7 ve beta/tanıtım yönü [yol haritasına](.deckent/docs/plan/roadmap-2026-10-15.md) bağlandı. Eski metnin sonradan aşılmış cümleleri tarihsel kaynak olarak okunur.
