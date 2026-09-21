# Deckent Next — ana plan

Bu dosya kalıcı ürün kararları, ana iş alanları ve önemli açık bulgular içindir. Küçük iş, iptal,
deneme ve koşum günlükleri buraya eklenmez. Anlık takip: [current-flow](follow-up-works/current-flow.md).
Bu geçici dosya her işte yeniden yazılabilir/silinebilir; geçmiş biriktirmez ve ürün sözleşmesi değildir.
Kalıcı mimari ayrıntılar [ARCHITECTURE.md](ARCHITECTURE.md), tarihsel kanıtlar refaktör çalışma alanındadır.
Owner ile kısa, görünür adımlar; uzun goal ve Fable kanalı kapalı. Jev danışmandır, kabul otoritesi değildir.

## Kalıcı yön ve kararlar

- Müşterinin kurduğu solo/team/on-prem/uzak/air-gapped ürün; Deckent SaaS işletmez. Güvenli Core bağımsız, Enterprise özel dağıtılır.
- Task iş birimi; run/do/autonomous yürütme girişleri, Mission hedef koordinasyonudur. Kind alanı modülerdir, yetki vermez; legacy alias taşınmaz.
- Tek durum/geçiş sahibi, katmanlı paketler, config/registry ile deterministik adapter seçimi. Kaynak boyutu kadar sorumluluk ve bağımlılık kapıları korunur.
- TypeScript Core korunur; Go ancak dar supervisor sınırında aynı iş/yük/arıza deneyiyle kazanım kanıtlanırsa seçilir.
- Proje `.deckent/config.json` sabit başlangıç kaydıdır; gerçek veri yolları yapılandırılır ve gösterilir. Ürün durumu `.deckent` düzeninde toplanır.
- Grafik v2 sürümlü kabul kriterleri ve kind→profil registry; Run adapter sürümü, yürütme kaydındaki tam profil ve ilk Git başlangıç commit'i sabitlenir. Başlangıç commit'i canlı teslim izni değildir.
- Yeni Run kabulü otomatik ilerleme niyetini atomik kaydeder; ayrı yürüt komutu yok. Ortak runtime güncel policy ile ilerletir; eski kayıtlar geriye dönük etkinleşmez.
- Ortak runtime; atomik başlatma izni, kalıcı iptal, kapsamı yapılandırılmış uzlaştırma/çıktı kurtarma. Shutdown süre sonunda işleri iptal etmeden eksik kapanabilir; güncel policy ve aktör audit'i zorunludur.
- Yerel kimlik OS peer credentials; uzak Enterprise güvenilir imzalı kimlik yönü. Kurulum açık, dar, sürümlü profil kabulüdür; mevcut policy sessizce ezilmez.
- IFS Cloud MCP ve Applications 10 native ilk ERP hedefidir. Kesin senaryo/erişim kanıtı dış işlemden önce belirlenir.
- Paralellik sayılarını ürün sabiti yapmayız. İlk yerel iş yükü 6–8 worker/up to 50 task; 8/30 bir kabul örneğidir. Büyük ölçek ancak ölçümle iddia edilir.

## Owner kararı — 2026-09-21: geliştirme dogfooding sırası

- Önce dar doğrulama önkoşulu görünürlüğü, ardından izole ortamda native tam izinli gerçek kodlama worker'ı ve kontrollü patch teslimi. Genel Deckent tool kataloğu ve anlık approval köprüsü ilk coding dogfood önkoşulu değildir; dogfood gözlemleriyle sonraki aşamada geliştirilir. Memory/Mission/Enterprise yüzeylerinin tamamı erken developer dogfood önkoşulu değildir; ürün kapsamı korunur.
- **Faz 1:** Codex, Claude ve Cursor headless ajanları Docker içinde, mevcut abonelik yetkileriyle çalışır. Önce tek adapter'ın gerçek izin/credential/çıktı/iptal/kurtarma uygunluğu kanıtlanır, sonra farklı ajan/model/persona/skill profilleriyle paralel görev dağıtımına genişlenir. Host oturumu seçimi çalışan ürün adapter'ı kanıtı değildir.
- **Worker imajı (owner 2026-09-21):** Codex, Claude ve Cursor aynı imajda zorunlu bulunur. İmaj güncellemesi güncel dağıtımları yeniden çözer, üç CLI uygunluğunu ölçer ve immutable imageId üretir. Run boyunca sürüm sabit kalır; yeni Run için güncellik seçimi admission tarafına bağlanacaktır. Eski imajlar devam eden işler/geri dönüş için korunur; çalışan konteyner kendini güncellemez.
- Deckent'in kendisine ait bir model geliştirme hedefi yoktur. Deckent iş dağılımını, kapasiteyi, izinleri ve kabulü yönetir; ajan davranışı native executor/provider üzerinden gelir. Task'a atanmış sürümlü profil model/persona/skill'i çözer; bunlar yetki vermez.
- **Faz 2:** yerel LLM runtime'ları, NVIDIA tabanlı model sunucuları ve OpenRouter/diğer provider API veya gerçekten desteklenen abonelik yolları. Mevcut yerel runtime adı/arayüzü kurulumdan doğrulanır; vLLM veya başka hazır çözümler ihtiyaç/ölçümle değerlendirilir, özel model-serving yazmak son seçenektir. GPU gözlem aracı model provider'ı sayılmaz.
- Abonelikte çağrı başına gerçek ek ücret0; API eşdeğeri simülasyon ayrı tutulur. Eksik simülasyon fiyatı işi durdurmaz; abonelik kota/erişilebilirlik sınırları uygulanır. Desteklenmeyen auth türü çalışıyormuş gibi ilan edilmez.
- **Onay:** ilgili işlem/kaynak/scope için yetkili insan kendi talebini kurumda da onaylayabilir; yetkisi yoksa yetkili kişinin kararı beklenir. Kurulum türü tek başına ikinci kişi zorunluluğu yaratmaz. Dogfooding'de tek admin Alperen; kimliği ürün koduna hardcode edilmez. Kurumun açık görev ayrılığı politikası ayrıca uygulanabilir.
- **İlk worker izin modu (owner 2026-09-21, güncel):** izole coding worker native unattended/full-access çalışır, kendi dosya/shell/test araçlarını kullanır; işlem başına insan onayı beklemez. Mod sürümlü profil verisidir. İlk kapsam workspace değişikliği/test/kanıt ve kontrollü teslimdir; host tam erişimi, Docker socket ve production/ERP yetkisi değildir. İptal/kurtarma, kaynak sınırları, provider auth ve sandbox sınırı korunur. Native loglar her etkiyi denetleme kanıtı sayılmaz. Genel tool/approval entegrasyonu dogfood sonrası kanıtla ele alınır; Go yönü adapter/protokol sınırından ölçülerek değerlendirilir.
- **Süre dolması:** request expired kapanır ve izin vermez; Task açık yenilemeye kadar beklemede korunur. Yeni istek güncel policy/eylemle oluşturulur; otomatik bildirim/yeniden-istek döngüsü yok. Çalışan veya etkisi belirsiz worker yalnız status değişikliğiyle kapasiteden düşürülemez.
- Fable devri yalnız owner açıkça “devret” dediğinde başlar. İş ve kanıt yürütücüden bağımsızdır; iletişim kanalı/uzun goal yeniden açılmaz.

## Ana iş alanları ve ilerleme yönü

Durumlar tamamlanmış ürün iddiası değildir; aşağıdaki harita çalışan bölüm ile açık kısmı ayırır.
Bağımlılık sırası: FOUNDATION/CONTRACT → STORE/SECURITY/ISOLATION → EXECUTION/PROVIDERS/SURFACES;
IFS-E2E ve DOGFOOD kendi uçtan uca kanıtından sonra, LANG ölçümle; ASSURANCE her aşamada uygulanır.

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
| LEARNING | Doğrulanmış sonuç→routing/skill/model iyileştirmesi; bağımsız eval, provenance ve geri dönüş. |
| ASSURANCE | Yük/arıza/platform matrisi, backup/restore, sürüm yükseltme ve Core/Enterprise ayrı yayın kanıtı. |

## Güncel yetenek haritası

### Bugün ne var, ne eksik?

| Alan | Next'te mevcut sorumluluk ve kaynak | Gerçek kapsam / eksik |
|---|---|---|
| Mimari ve ayarlar | [Platform](src/platform/core), [composition](src/composition/core), [mimari kapısı](scripts/lint-arch.mjs) | Katman, birim bağımlılığı, döngü ve bütçe kapıları var; modülerlik tüm ürün özelliklerinin tamamlandığı anlamına gelmez. |
| Kurulum / dosya düzeni | [Kurulum motoru](src/engine/core/installation), [kurulum composition](src/composition/core/installation) | Özel profil preview/apply/resume, kalıcı journal ve çakışma koruması; yayıncı doğrulamalı hazır varsayılan kurulum tamam değil. Proje `.deckent/config.json` başlangıç kaydı sabit, veri kökü yapılandırılabilir. |
| Kimlik / policy | [Authentication](src/engine/core/authentication), [policy](src/engine/core/policy), [yerel principal](src/adapters/core/local-principal) | Yerel OS kimliği ve kapsam/işlem denetimi; SSO, uzak kimlik federasyonu ve tam Enterprise RBAC/RLS ürünü yok. |
| Run / Task / scheduler | [Runs](src/engine/core/runs), [scheduling](src/engine/core/scheduling), [dispatch](src/engine/core/dispatch) | Grafik kabulü, bağımlılık, rezervasyon, attempt ve atomik başlatma/iptal kayıtları; genel AI planlama ve tüm iş alanları tamam değil. |
| Worker / sandbox | [Docker](src/adapters/core/docker-supervisor), [execution composition](src/composition/core/execution), [native bağlantı](src/adapters/core/native-connection) | Gerçek görev yolu Git+Docker; doğrudan ağ kapalı. Native abonelik profilinde sağlayıcı HTTPS allowlist + DNS/IP/SNI denetimli Unix geçidi ve geçici kimlik bağlı; host HOME/socket ve refresh token aktarılmaz. Kısıtlı mount/yetki/kaynak ve mevcut custody korunur. Host .hb/.log/.result gözlemleri ve kayıtlı Next/legacy yerel kaynakları birleştiren SDK/CLI izleme bağlı; dosya tazeliği süreç/görev kabulü değildir. Native refresh/olay/usage ve çoklu hesap yaşam döngüsü açık. Process supervisor modülü var; tmux/uzak/Windows/Firebase ürün kanıtı yok. Ortak kernel izolasyonu VM garantisi değildir. |
| Workspace / kaynak sürümü | [Git workspace](src/adapters/core/git-workspace), [workspace motoru](src/engine/core/workspaces) | Attempt başına bağımsız Git clone, detached base, origin kaldırma, hook kapatma; `git worktree` implementasyonu değil. Run base sabitliği ve host üreticisine bağlı değişmez metin patch hazırlama/SDK-CLI önizleme mevcut (ledger29); hedefe uygulama ve güvenli birleştirme/ERP teslimi eksik. |
| Çıktı / kabul | [Artifacts](src/composition/core/artifacts), [task evaluation](src/engine/core/task-evaluation), [task inputs](src/engine/core/task-inputs) | Dosya/çıkış kanıtı toplama ve değerlendirme; kabul edilmiş doğrudan bağımlının stdout/stderr kaydı açık girdi seçimi ve ayrı okuma yetkisiyle yerel Docker görevine salt-okunur bağlanır. Sürümlü Docker profilinde seçilen isimli dosyalar duruş sonrası sınırlı, bağlantı izlemeyen okumayla ayrı artifact olarak toplanır; eksik/güvensiz dosya kabulü engeller. Bağımlı görev isimli dosyayı açıkça seçebilir; receipt/hash ve okuma yetkisi doğrulanıp readonly bağlanır. Uzak aktarım, Brain'in iş anlamını doğrulaması ve canlı hedefe güvenli teslim tamam değil. |
| Runtime / kurtarma | [Runtime service](src/composition/core/runtime-service), [runtime motoru](src/engine/core/runtime) | Yerel Linux soketi, sınırlı concurrency, policy/auditli shutdown; yeni kabulün otomatik niyeti, aktör eşleşmeli tarama ve değerlendirilmemiş çıktı kurtarması bağlı; kabul sonrası uygun boş slot aynı Run içinde yeniden doldurulur; otomatik tur yapılandırılmış rezervasyon bütçesinde mevcut işleri tamamlayıp sırayı sonraki Run’a devreder; süre sonunda işleri iptal etmeden eksik kapanış. Kayıtlı profilden iptal/çıktı kurtarma; HA/uzak daemon iddiası yok. |
| Provider katalog / aktivasyon | [Catalog](src/engine/core/provider-catalog), [activation](src/engine/core/model-activation) | Sürümlü metadata, binding ve kapsamlı kalıcı activation/revocation. Katalog kaydı native çağrı desteği kanıtı değildir. |
| Model çağrısı / secret | [Invocation](src/engine/core/model-invocation), [native composition](src/composition/core/model-invocation) | Runtime sahipliğinde native metin HTTP; OpenRouter fiyat/bütçe yolu bağlı. OpenAI-chat adapter var; bütün providerlar/abonelikler uçtan uca bağlı değil. Streaming/tool/multimodal döngü eksik. Secret referansı çağrı anında çözülür; genel vault/OAuth yaşam döngüsü tamam değil. |
| Model iptali / içerik | [Invocation persistence](src/adapters/core/sqlite-model-invocation) | Kalıcı iptal, canlı HTTP abort, receipt/content ayrımı ve yetkili mantıksal purge. Servis kaybı uzak etkinin olmadığını kanıtlamaz; fiziksel WAL/backup silme garantisi yok. |
| Kota / para / audit | [Allocation](src/engine/core/model-allocation), [spend](src/engine/core/provider-spend), [spend composition](src/composition/core/provider-spend) | Atomik rezervasyon/settlement, hesap görünümü, kalıcı scope kontrollü audit. Periyodik audit, fatura düzeltmesi ve abonelik gerçek/simülasyon ayrımı eksik; audit consistent sonucu sağlayıcı faturasıyla uzlaşma değildir. |
| Veri depolama | [SQLite ledger](src/adapters/core/sqlite-ledger), [storage composition](src/composition/core/storage) | Transactional SQLite yolu var. PostgreSQL/Mongo/vector/nesne deposu adapter'ları ve eşdeğer tutarlılık kabulü tamam değil. |
| Diğer ürün yetenekleri | [Hedef mimari](ARCHITECTURE.md) | Brain/Auditor/Nervous tam döngüsü, Mission/do/autonomous, öğrenme, IFS ve genel tool/approval işi henüz ürünleşmiş kabul edilmez. Parasal audit genel Auditor değildir. |
| Dağıtım / Enterprise / Go | [Hedef sınırlar](ARCHITECTURE.md) | Desktop/TUI/web/uzak API, SSO/fleet/HA/restore/ölçek kabulü ve Go supervisor ölçümü açık. TS yürütme çekirdeği mevcut; Go entegrasyonu yapılmış değil. |

### Hangi yüzey nereye bağlanıyor?

| Yüzey | Giriş / bağlantı | Sınır |
|---|---|---|
| SDK | [src/index.ts](src/index.ts) | Model çağrısı ve spend runtime yardımcılarına gider; Run/Task işlemlerinin bir bölümü doğrudan configured composition export eder. Her SDK işlemi servisten geçiyor denemez. |
| CLI | [CLI composition](src/composition/core/cli), [CLI yüzeyi](src/surfaces/core/cli) | Kurulum, inceleme ve runtime komutları var; komutların varlığı sohbetle tam otonom iş teslimi değildir. |
| MCP server | [MCP composition](src/composition/core/mcp), [transport](src/adapters/core/mcp-transport) | Stdio tools; Run/Task/model/hesap yolları runtime kullanır, katalog/aktivasyon doğrudan composition. HTTP server ve bütün protokol capability'leri tamam değil. |
| MCP client | [Paket beyanı](package.json) | Client SDK test bağımlılığıdır; ürünün dış MCP server'a bağlanan client/connector yolu henüz yok. |
| Diğer UI / API | [Hedef mimari](ARCHITECTURE.md) | Desktop, TUI, web ve uzak API için tamamlanmış ürün yüzeyi iddiası yok. |

### Ayarların sahipliği ve çalışma karşılığı

Tam alan/ağaç kaynakları: [temel config](src/platform/core/config-fields/internal/fields.ts), [adapter kayıtları](src/adapters/core/contract/internal/config.ts). Alt alanların otoritesi bu şemalardır; burada ikinci bir şema kopyalanmaz.

| Grup | Alanlar | Sahiplik / durum |
|---|---|---|
| Kimlik ve sunum | `schema_version`, `language`, `projectName`, `mode`, `output_mode`, `live_trace` | Platform/config ve ilgili tüketiciler; seçilebilir enum her modun tamamlandığı kanıtı değildir. |
| Proje kaynakları | `layout`, `storage`, `artifacts` | Config → composition → SQLite/dosya adapter'ları. Storage driver bugün SQLite ile sınırlı. |
| Kurulum ve yürütme | `installation`, `execution`, `admission`, `max_workers`, `spawn_backend` | Gerçek admission/pool ve Docker/Git profilleri ayrı sorumluluklar; `spawn_backend=tmux` beyanı çalışan tmux route'u değildir. |
| Yüzey / servis sınırları | `cli`, `mcp`, `service`, `inspection` | Girdi/yanıt/concurrency/policy boyutu ve servis yaşam döngüsü; yüzey bazlı sayaç sistem çapında kota sayılmaz. |
| Kurtarma | `cancellation`, `cancellationRuntime`, `reconciliationRuntime` | Motor/service kapsam, tekrar ve paralellik sınırları; dış etkinin geri alınacağını vaat etmez. |
| Scope / güven | `enforce_principal_assurance`, `strict_tenant_isolation`, `tenant_id` | Config beyanları tam Enterprise izolasyon/IdP ürünü anlamına gelmez; gerçek policy yolları ayrıca kanıtlanır. |
| Provider seçimi | `auth_mode`, `providers`, `provider_catalog` | Katalog/seçim metadata'sı; `subscription` enum'u abonelik çağrısının uçtan uca çalıştığını kanıtlamaz. |
| Çağrı / parasal yetki | `provider_invocation_profiles`, `provider_spending`, `provider_spend_audit` | Gerçek invocation allocation/limit, fiyat bütçesi ve audit sınırları burada bağlanıyor. |
| Beyan edilen limit | `provider_limits` | Kayıt/validasyon mevcut; engine/composition tüketicisi yok, limit uygulamıyor. Invocation profil kotasıyla karıştırılmaz. |

### Kabul edilmiş yeni yönler — kodda henüz tamam değil

- **Canlı teslim:** başlangıç kanıtı, görevin okuduğu girdiler ve t1 hedef koşulları ayrılacak. Run commit'i tek başına teslim güvenliği değildir. Git koşullu birleştirme/yeniden doğrulama; ERP kayıt sürümü/iş koşuluyla atomik yazma veya açık sınırlı adapter garantisi. Sessiz ezme/kör tekrar yok; mevcut kod değişmedi.
- **Tool yetkisi:** dosya okuma/yazma/silme, ağ ve iş operasyonu policy'si ortamdan ayrı tanımlanacak; Docker/tmux vb. adapter yalnız gerçekten uyguladığı sınırı sunacak. Shell erişimi varken silme tool'unu gizlemek izolasyon değildir.
- **Maliyet:** ek çağrı ücreti olmayan abonelikte gerçek çağrı maliyeti 0, API eşdeğeri ayrı simülasyon. Simülasyon fiyatı eksikse bilinmiyor; yürütmeyi engellemez. Ücretli API'nin gerçek bütçe denetimi korunur. Provider kapsamı OpenRouter ile sınırlı hedeflenmez.
- **MCP takip kayıtları:** MCP-CLIENT, MCP-CONNECTIONS, MCP-REMOTE, MCP-TOOL-EXECUTION, MCP-EFFECT-RECOVERY, MCP-CAPACITY, MCP-VERSION-CAPABILITIES, MCP-SERVER-CONSISTENCY, MCP-IFS. Ayrıntılı kabul koşulları arşiv raporda korunur; bu liste uygulama başlangıcı değildir.
- **Diğer açıklar:** `provider_limits` kayıtlı fakat uygulanmıyor; A3A-b belirsiz custody, CANCEL/FAIRNESS, model dışı MCP mutasyonunun işlem öncesi yanıt sınırı, D-CUSTODY; periyodik parasal audit/append-only düzeltme, makine okunur maliyet kırılımı, gerçek ücretli çağrı credential ve sayısal tavan kabulü. HOST-JEV-EVIDENCE ayrı WIP, ürün kabulü değil.

## Önemli açık bulgular

- **PROVIDERS — aralıklı `unknown`: AÇIK.** Teşhis owner kararıyla sınırlandırıldı; hata çözülmüş sayılmaz. 800 tekrarda özgün unknown yakalanmadı; bir çağrı öncesi fiyat yetkisi reddi görüldü. Güvenlik/bütçe denetimi ve belirsiz etki koruması değiştirilmedi. Gerçek tekrar veya yeni kanıtta yeniden açılır. [Kanıt](../deckent-refactor-work/proof/UNKNOWN-BOUNDED-DIAGNOSIS/verification.json).
- **EXECUTION — kısmi havuz rezervasyonu uygulandı:** ortak havuzun kalan execution/in-flight kapasitesi transaction içinde değerlendirilir; yalnız sığan sıralı adaylar ayrılır, tekrar aynı kimlikleri döndürür. Ledger24. [Kanıt](../deckent-refactor-work/proof/ATOMIC-PARTIAL-WAVE/verification.json).
- **EXECUTION — koşullu akış kısmi:** kabul anında tek dal seçimi kalıcıdır; Run ortası koşul, timer/signal, kaynak kilidi henüz tamam değildir; otomatik yerel ilerleme bağlı, Run içi tamamlanmaya göre slot doldurma bağlı; Run'lar arası sınırlı rezervasyon turuyla sıra devri bağlı; uzun worker’ı kesmeden zaman bazlı adalet, dağıtık paylaşım ve genel BPM hâlâ açıktır.
- **ISOLATION — canlı teslim açık:** Git/ERP başlangıç kanıtı ile t1 hedef koşulu ayrılmalı; kaynak kilidi dış insan/ERP yazıcısının değişikliğini engellemez.

## Kanıt, geçmiş ve ölçüm

Bu checkpoint’in baz commit’i `8fb7ea7`; teslim commit’i Git geçmişinde izlenir. Tam doğrulama:
1460 ürün/254 dosya, 24 native, 29 host; lint/typecheck/arch/build/smoke geçti. Tarihsel migration
fixture'ları v25 tablolarını eski sürümde bırakmayacak şekilde düzeltildi; ürün migration'ı gevşetilmedi.
Bu doğrulama açık model unknown'ının çözüldüğü anlamına gelmez.
[Checkpoint kanıtı](../deckent-refactor-work/proof/CHECKPOINT-2026-09-21/verification.json).
DOGFOOD_MODE=OFF. Ağırlıklı yetenek paydası kabul edilmediğinden genel tamamlanma yüzdesi verilmez.

- [Temizlik öncesi eksiksiz plan ve tarihsel kartlar](../deckent-refactor-work/archive/PLAN-before-flow-split-2026-09-21-55a9ec25aa3b.md) — geçmiş/iptal/kanıt; aktif yürütme izni değildir.
- [İlk onaylı refaktör planı](../deckent-refactor-work/PLAN-APPROVED-2026-09-16.md) ve [backlog kaynağı](../deckent-refactor-work/backlog/MASTER-EXTRACT-2026-09-16.md) — güncel owner kararlarıyla çelişen legacy öneriler uygulanmaz.
- Yeni kalıcı karar ilgili ana satır/ARCHITECTURE'da güncellenir; küçük iş takibi yalnız current-flow'da tutulur.

Owner decision 2026-09-21: Next is the only execution host; deckent-dev remains read-only
refactor reference. Local CLI/MCP routing and isolated global configuration belong to Next.
Worker observation reads explicit local project/task roots without adopting legacy execution authority.
