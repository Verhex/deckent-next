# Deckent rakip taraması ve beta işleri

**Tarih:** 20 Ekim 2026. **Kaynak tabanı:** `ed76781309d2380ad5fe0e60ac06327e1eaf36bb`, paket sürümü `1.0.0-alpha.49`. **Durum:** BETA-RAKIP-1…4 owner talimatıyla beta süreci planına alındı; uygulama ve kabul açık. **Sahiplik:** lead mevcut işlerle eşler ve uygulama sahiplerini belirler; bu belge kişi ataması yapmaz.

En yüksek kısa vadeli kazanım, mevcut yetenekleri ilk kalıcı sonuca kadar tamamlanan bir kullanıcı yolculuğuna bağlamak. Öncelik adayları: ilk iş için elle yapılandırmayı azaltmak, işçiye aynı terminalden cevap vermek ve kesinti sonrası devamı gerçek sonuçla kanıtlamak. Temel etki motorunu yeniden yazmayı gerektiren bir bulgu yok.

## Kapsam ve kanıt

Kullanıcı sayısı, yıldız, indirme, topluluk büyüklüğü, satış ve pazar payı değerlendirmeden çıkarıldı. Deckent'in yayımlanmamış olması bu göstergeler üzerinden eksi puan oluşturmaz. Ölçülmemiş hız, güvenilirlik veya başarı için puan verilmedi.

Rakiplerde 20 Ekim 2026 erişimli resmi belgeler incelendi; aşağıdaki bağlantılar yaşayan belgelerdir, değişmez sürüm kaydı değildir. Rakipler kurulup çalıştırılmadı ve karşılaştırmalı benchmark yapılmadı. Deckent'te kaynak bağlantısı, planlanmış iş ve belgelenmiş kabul açığı ayrıldı. Kaynakta mekanizma bulunması çalışan paket veya canlı kabul kanıtı sayılmadı.

Owner araştırma tesliminden sonra “Güzel betadaki iş maddeleerine ekleyebilirsin bunları detaylarıyla.” diyerek öncelikli dört kartın beta işlerine eklenmesini istedi. [PLAN Sıradaki 15](../../../PLAN.md), [ayrıntılı iş eşlemesi](roadmap-2026-10-15.md#beta-rakip) ve [karar kaydı](../decisions/owner-decisions.md#beta-rakip-2026-10-20) bu kabulü taşır. Mevcut beta öncesi sekiz kapı, kod dondurması ve istisnaları korunur; plan eklemesi yeni beta çıkış koşulu oluşturmaz. [Paperclip/Hermes A0–A7 brief'i](post-beta-productization-paperclip-hermes.md) bütünüyle erkene alınmaz.

## Rakiplerden alınabilecek yöntemler

Ürünler aynı kategoride değil: Paperclip iş/ajan yönetimi, Hermes kişisel ajan kullanımı, OpenHands yazılım ajanı; LangGraph ve Temporal yürütme altyapısı; n8n entegrasyon iş akışları, Dify müşteri ortamında AI uygulama/iş akışı geliştirme; Copilot Studio ve UiPath kurumsal süreç yönetimi referanslarıdır. Bu yüzden toplam özellik sayısı sıralaması yerine aynı sorumluluğun nasıl çözüldüğü karşılaştırıldı.

| Referans | Belgelenmiş davranış | Deckent için çıkarım | Taşınmaması gereken varsayım |
|---|---|---|---|
| **Paperclip** | [Quickstart](https://github.com/paperclipai/paperclip/blob/master/docs/start/quickstart.md) ilk göreve kadar yol tarif ediyor. [Heartbeat](https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md) iş sahipliği çakışmasında 409'u tekrar denememeyi ve onayı plan revizyonuna bağlamayı anlatıyor. [Execution semantics](https://github.com/paperclipai/paperclip/blob/master/doc/execution-semantics.md) beklemeyi bağımlılık veya sorumlu kişinin eylemiyle açıklıyor. | **UYARLA:** “kim, neyi yapınca devam edecek?” mevcut terminal iş detayında cevaplanmalı. İlk kurulum gerçek göreve ulaşmalı. | Şirket/CEO/organizasyon ağacını ilk solo işe zorunlu yapmak; canlılık göstergesini işin kabulü saymak. |
| **Hermes** | [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) çalışan provider ve ilk sohbeti önce doğruluyor. [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) isteğe bağlı bekletme/inceleme/onay ve değişmiş hedefe eski öneriyi uygulamama yolunu açıklıyor. [MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) şema yenileme ve yeniden yetkilendirme durumlarını ayırıyor. | **UYARLA:** ilk başarısız katmanı açık göster; kayıtlı bağlantı ile kullanılabilir bağlantıyı ayır. Kontrollü öğrenme incelemesi A6 girdisi. | Memory yazı onayının kapalı varsayılanını almak; sohbetin çalışmasını ilk kalıcı iş sonucu saymak. |
| **OpenHands** | [Security](https://docs.openhands.dev/sdk/guides/security) risk analizi ile onay politikasını ayırıyor; doğrudan `execute_tool()` yolunun bu kapıları atladığını belirtiyor. [Persistence](https://docs.openhands.dev/sdk/guides/convo-persistence) konuşma, olay ve yürütme durumunu saklıyor. [Metrics](https://docs.openhands.dev/sdk/guides/metrics) yardımcı model kullanımlarını da maliyete katıyor. | **AL:** her giriş yolunda aynı yetki sınırını incele; devamlılık ve yardımcı çağrı maliyetlerini kullanıcıya doğru göster. | Risk puanını yetki yapmak; sohbeti geri yüklemeyi dış etkilerin güvenli kurtarılmasıyla eşitlemek. |
| **LangGraph / LangSmith** | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) insan girdisi için durma/devamı; [persistence](https://docs.langchain.com/oss/python/langgraph/persistence) kalıcı checkpoint'i açıklıyor. Kesilen düğüm devamda baştan çalışabilir; önceki yan etkiler yinelenebilir. [Agent Auth](https://docs.langchain.com/langsmith/agent-auth) OAuth bekleme/yenileme akışı sunuyor ve beta etiketi taşıyor. | **AL:** insan girdisi, restart ve tamamlanan kardeş görevlerin korunması birlikte sınanmalı. **SONRA:** bağlantı gerektiğinde aynı işin güvenli beklemesi. | Graph checkpoint'ini hedef sistemde tek etki garantisi saymak; RAM kaydına kalıcılık atfetmek. |
| **Temporal** | [Workflows](https://docs.temporal.io/workflows) geçmişten replay'i, [approval rehberi](https://docs.temporal.io/guides/reliable-document-approvals) kalıcı beklemeyi anlatıyor. [MCP entegrasyonu](https://docs.temporal.io/develop/python/integrations/mcp) timeout'un isteği durdurmadığını, cevap kaybının retry doğurabileceğini ve `is_error` sonucunun ayrıca yorumlanması gerektiğini belirtiyor. | **AL:** “istek zaman aşımına uğradı”, “etki olmadı”, “iş kabul edildi” ayrı sonuçlardır. Bunları beta arıza provasına ekle. | Temporal'ı yeni çekirdek bağımlılığı yapmak; otomatik retry'ı genel çözüm saymak. MCP entegrasyonu pre-release. |
| **n8n** | [Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait) kalıcı bekleme ve çalışmaya özel devam adresini anlatıyor; 65 saniyeden kısa zaman beklemesi DB'ye boşaltılmıyor. [Google OAuth](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service) self-host için özel uygulama ve yeniden bağlantı gereksinimlerini açıklıyor. | **UYARLA:** entegrasyon yalnız ilk bağlantı değil; süre dolması, geri alma ve işe dönüşten oluşur. Kısa/uzun bekleme ayrı arıza senaryolarıdır. | Connector sayısını çalışan iş sayısı saymak; kimlik doğrulamasız devam adresini Deckent onay yolu yapmak. |
| **Dify** | [Self-host kurulum](https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose) uygulamaya geçişi; [Human Input](https://docs.dify.ai/en/self-host/use-dify/nodes/human-input) form, karar ve timeout dallarını; [logs](https://docs.dify.ai/en/self-host/use-dify/monitor/logs) girdi/çıktı ve adım izini bir araya getiriyor. | **UYARLA:** kurulum, insan girdisi ve sonucun incelenmesi kopmamalı. Üretim koşumu ile editör denemesi ayrı gösterilmeli; saklama sınırı anlaşılır olmalı. | E-posta bağlantısını bilenin hesap olmadan yanıtlayabilmesini Deckent yetki modeli yapmak; aynı girdilerle yeniden çalıştırmayı etkilerin güvenli tekrarı saymak. |
| **Microsoft Copilot Studio** | [Credential policy](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-no-maker-authentication) araç sahibinin hesabıyla son kullanıcının hesabını ayırıyor. Son kullanıcı girişi zorunlu olduğunda otonom tetiklerin çalışamaması açık bir bedel. [Çok aşamalı onay](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals) halen preview; ALM desteği sınırlı. | **AL:** “kimin adına, hangi kimlikle?” bağlantı ve işlem yüzeyinde görünür olmalı. Katılımsız çalışma ayrı yetkili kimlik ister. | Kolaylık için insan hesabını sessiz servis kimliği yapmak; AI onayını Deckent'in insan yetki tabanının yerine koymak. |
| **UiPath Maestro** | [Human node](https://docs.uipath.com/maestro/automation-cloud/latest/user-guide/node-human) kişinin girdisini bekler ve sonuçla devam eder. [Instance management](https://docs.uipath.com/maestro/automation-cloud/latest/user-guide/process-overview-homepage) işlem geçmişi, sorumlu, pause/resume ve recovery eylemlerini aynı işte toplar; “go to” için tutarlılık riskini belirtir. | **UYARLA:** genel iş sürecinde soru, karar, bekleme ve kurtarma aynı iş kimliğiyle izlenmeli; yalnız teknik log yeterli değil. | Keyfi adıma atlamayı güvenli kurtarma saymak; Automation Cloud belgelerini bağımsız/air-gapped Core kanıtı olarak kullanmak. |

**Stratejik çıkarım:** “policy ve multi-agent var” tek başına ayırt edici değil. Deckent'in savunulabilir yönü, müşteri altyapısında farklı ajan ve araçları ortak yetki, izolasyon, kabul ve etki sözleşmesine bağlama hedefi. Bu yön kaynakta karşılık buluyor; rakiplere karşı üstünlük ve gerçek ERP başarısı henüz ölçülmüş değil.

## Deckent'te mevcut olan ve açık kalan

| Sorumluluk | Güncel kaynakta görülen | Gerçek açık |
|---|---|---|
| Kurulum | [init.ts](../../../src/surfaces/core/cli-installation/internal/init.ts) satır 44–49 setup'a yönlendiriyor; [controller.ts](../../../src/surfaces/core/setup/internal/controller.ts) aşamayı uygulayıp yeniden gözlüyor. | [first-job.json](../../../src/surfaces/core/doctor/internal/first-job.json) satır 5–11 worker imajı, execution JSON, registry ve pool'u sonraki komutlar olarak bırakıyor. [first-job.ts](../../../src/surfaces/core/doctor/internal/first-job.ts) satır 5–7 gerçek imaj varlığını denetlemiyor. [Bilinen sınırlar](../../../docs/known-limits.tr.md) satır 30–42. |
| Bekleyen insan işi | [active-work.tsx](../../../src/surfaces/core/terminal-work/internal/active-work.tsx) satır 36 `needs-input` işini öne alıyor. | Aynı terminalden cevap yolu yok; [CLI run-control](../../../src/surfaces/core/cli-run/internal/run-control.ts) satır 38–81 mevcut `answer` sözleşmesini kullanıyor. [Bilinen sınırlar](../../../docs/known-limits.tr.md) satır 262–263. |
| İnsan okunur CLI | [approval-view.ts](../../../src/surfaces/core/cli-approval/internal/approval-view.ts), [kuyruk tablosu](../../../src/surfaces/core/delivery-queue/internal/list-table.ts) ve [kabul açıklaması](../../../src/surfaces/core/cli-human/internal/acceptance.ts) mevcut. | PLAN'ın alpha.46 ölçümündeki her CLI kusuru yeni eksik sayılamaz. Kaynakta düzelen davranışın exact paket ve gerçek terminal kabulü ayrıca gerekir. |
| Etki güvenliği | [EffectApplication](../../../src/engine/core/effect/internal/application.ts) satır 123–226 koşullu yazma, onay, kimlik, lookup ve belirsiz sonuç uzlaştırması içeriyor. | Generic mekanizma gerçek ERP adapter'ının yerine geçmez. [Bilinen sınırlar](../../../docs/known-limits.tr.md) satır 268–291 adapter, işlem geçmişi ve insan uzlaştırması açıklarını listeliyor. |
| MCP | [McpToolTarget](../../../src/adapters/core/mcp-client/internal/target.ts) satır 22–50 onay beklemesinden sonra güven/tanım kontrolü ve belirsiz gönderimi tekrar etmeme sınırı içeriyor. | OAuth yok; generic MCP çağrısının lookup'u `null`, telafisi yok. Bu sınır “bütün connector etkileri uzlaştırılır” iddiasını engelliyor. |
| Harcama | [Harcama hesabı](../../../src/engine/core/provider-spend/internal/account.ts) scope bütçesi, rezervasyon, hold ve aşımda dondurma taşıyor. | Run toplam tavanı yok; [bilinen sınırlar](../../../docs/known-limits.tr.md) satır 188–197. Yeni Run bütçesi küçük bir gösterge değişikliği değil, ortak hesaplama/iptal/uzlaştırma işi. |
| İzolasyon ve denetim | [Audit integrity](../../../src/engine/core/audit/internal/integrity.ts) kayıt mühürleme/doğrulama içeriyor; ortak uygulama ve sandbox sınırları [ARCHITECTURE](../../../ARCHITECTURE.md) içinde. | Native worker'ın kendi araçları çağrı başına Deckent onayından geçmiyor; aynı OS hesabındaki dış ajan için izolasyon güvencesi yok. [Bilinen sınırlar](../../../docs/known-limits.tr.md) satır 59–61 ve 114–135. |

Platform kapsamı da ürün değerlendirmesinin parçası: kaynak belgeleri Linux/WSL2 yolunu ayırıyor; native Windows runtime desteklenmiyor ve macOS runtime/gerçek kabul boşlukları var. Bu tarama platform kabulü yapmadı. Tüm platformlara eşit destek iddiası betaya eklenmemeli. [Bilinen sınırlar](../../../docs/known-limits.tr.md), satır 12–27.

<a id="beta-isleri"></a>

## Beta iş kartları

Bu dört kart **planlandı**. İlk araştırmadaki belge içi B1–B4 adları, mevcut Terminal kararlarıyla karışmaması için BETA-RAKIP-1…4 olarak adlandırıldı. Kapsam ve kabul ayrıntıları burada; sıra ve mevcut iş sahipliği eşlemesi yol haritasında, çalışma durumu host panosundadır.

<a id="beta-rakip-1"></a>

### BETA-RAKIP-1 İlk kalıcı işe kadar yönlendirilmiş kurulum

**Kullanıcı sonucu:** desteklenen temiz makinede `init → /do → kabul → teslim`, lead yardımı ve elle execution JSON yazımı olmadan tamamlanır. İlk chat cevabı bu sonucun yerine geçmez.

**Neden önce:** açık zincir kaynakta görülebiliyor ve mevcut beta kapısı 4 zaten bu sonucu istiyor. Hermes/Paperclip'in kurulumdan ilk işe geçiş disiplini uyarlanabilir.

**Uygulama sınırı:** mevcut setup aşamaları, registry/config, worker image ve pool komutları üzerinden ilerle. İmajı adlandırmak, makinede bulunması ve başarılı işçi başlatması ayrı kanıttır. Doctor salt okuma olarak kalır; kontrol için kendiliğinden container başlatılmaz. Yeni yazma veya kurulum adımı mevcut insan onayını kullanır; `--yes`, pipe veya AI yolu yetki genişletemez. Provider/model/kapasite seçimleri güncel registry'den gelir.

**Bağımlılık ve sahip:** setup/installation sorumlusu; worker paketi ve teslim hedefi hazır olmalı. INSTALLATION + MUSTERI-YOLCULUK 1–2/4 ve beta kapısı 4 ile aynı iş olarak yürür; lead tek uygulama sahibi belirler. Geliştirme beta sürecine planlandı; mevcut beta öncesi temiz kurulum kanıt kapısı ertelenmez ve kod dondurmasına bu kayıtla istisna verilmez.

**Uygulama adımları:** mevcut setup'ın tamamlanan ve eksik aşamalarını yeniden gözle; imaj, execution, registry ve pool seçimlerini kendi yönetilen komutlarına bağla; ret/iptal veya yarım kurulumda güvenli sonraki adımı göster; hazır işçiden ilk `/do` ve teslim hedefine geç. Ayar kaydı, imaj varlığı, işçi çalışabilirliği ve gerçek teslim ayrı doğrulanır.

**Kabul:** exact paketle boş Docker/kurulum ortamında gerçek ilk iş ve kalıcı teslim; yarıda bırakıp dönme, olmayan imaj, çalışmayan Docker, yanlış scope, reddedilen onay ve ikinci kez init. Reddedilen adım hiçbir etki üretmemeli; tekrar kurulum kabul edilmiş ayarları sessizce değiştirmemeli. İlk yanıt süresi, ilk kalıcı sonuç süresi ve insanın aktif çalışma süresi ayrı kaydedilir.

<a id="beta-rakip-2"></a>

### BETA-RAKIP-2 İşçinin sorusuna aynı terminalden cevap

**Kullanıcı sonucu:** bekleyen işi seçer, soruyu ve hangi göreve ait olduğunu görür, yanıtlar; aynı Run uygun noktadan devam eder.

**Neden ikinci:** motor ve CLI cevap sözleşmesi mevcut; boşluk terminal tüketicisinde. Paperclip ve UiPath'ten alınacak ders, bekleme nedenini kullanıcının yapabileceği eyleme bağlamak. “Bekleyen işler ekranı yok” diye yeni ekran veya motor açılmaz.

**Uygulama sınırı:** mevcut iş detayı ve `runLifecycleCommandSchema` içindeki `answer`; scope, task, güncel revizyon ve sistemin ürettiği komut kimliği korunur. Onay ve bilgi yanıtı farklı işlemler olarak kalır. Mesajlaşma kanalı veya Desktop onayı eklenmez.

**Bağımlılık ve sahip:** terminal-work ve mevcut lifecycle tüketicisinin tek yazarı. WORKER-NEEDS-INPUT, KOMUT-BIRLESTIRME S3/S8 ve YUZEY-UYUM S12a aynı iştir; [PLAN](../../../PLAN.md) “Sıradaki 9/15” bu bağı taşır. Beta sürecine planlandı; mevcut komut dalında ayrıca ikinci cevap akışı yazılmaz.

**Uygulama adımları:** mevcut iş detayında soruyu, task'ı ve bekleme nedenini aç; cevap metnini aynı yüzeyde al; güncel revision/scope/kimlikle mevcut `answer` komutunu gönder; makbuzdan sonra yeni iş durumunu göster. Bu sırada iş değişmişse eski cevabı sessizce başka göreve taşıma; güncel durumu gösterip yeniden karar iste.

**Kabul:** gerçek işçi sorusu → terminal yanıtı → kalıcı cevap → aynı Run'ın devamı. Eski revizyon, yanlış görev/scope, iptal edilmiş iş, çift gönderim, kopan bağlantı ve yetkisiz kişi negatifleri. Esc/ret cevap yazmaz; ikinci gönderim ikinci etki oluşturmaz; TR/EN ve klavye akışı kontrol edilir.

<a id="beta-rakip-3"></a>

### BETA-RAKIP-3 Kesinti ve yeniden başlatmada doğru sonuç

**Kullanıcı sonucu:** bağlantı ya da süreç kesildiğinde neyin tamamlandığını, neyin belirsiz kaldığını ve nasıl ilerleyeceğini bilir.

**İş türü ve sahip:** önce mevcut beta kanıt işi; RESTART-RECOVERY W11 ve MARK-LOST-ATOMIC/KARAR 12 ile kapı 4/7'ye bağlıdır. Lifecycle/effect sahibi teknik farkı, yetkili lead gerçek koşumu taşır. LangGraph/Temporal/n8n sınırları arıza senaryosu seçiminde kullanılır; yeni recovery motoru açılmaz.

**Uygulama adımları:** exact adayın mevcut recovery yollarını ve saklanan kanıtını eşle; aşağıdaki senaryolarda etkiden önce/sonra kesinti noktalarını belirle; yetkili ortamda gerçek hedef kaydıyla sonucu karşılaştır; bulunan kusuru mevcut geçiş sahibinde dar düzeltmeyle ve aynı negatif senaryoyla kapat. Farklı sürümün eski başarısı yeni adayın kabulü yerine kullanılmaz.

**Asgari senaryolar:** insan kararını beklerken servis restart; başarılı kardeş görev varken worker kaybı; dış hedef yazdıktan sonra cevap kaybı; timeout sonrası geç cevap; onaydan sonra policy/hedef revizyonu değişimi; iptal sonrası yanıt; iki kez aynı karar; taşıma başarılıyken araç iş hatası.

**Kabul:** exact aday, ortam, işlem kimliği, dış hedefteki kayıt ve yerel makbuz birlikte tutulur. Tamamlanmış iş ikinci kez etkilenmez. Hedef sonucu sorgulanamıyorsa `unknown` korunur; sırf kullanıcı beklemesin diye yeniden gönderim veya başarı yok. Güvenli reddin yanında kullanıcının sonraki adımı da gerçek yüzeyde görülür. Gerçek canlı/N1 müdahalesi lead'in ayrı yetkisinde; bu araştırmada yapılmadı.

<a id="beta-rakip-4"></a>

### BETA-RAKIP-4 Mevcut kullanıcı yolculuğunun kabul paketi

**Kullanıcı sonucu:** hangi sınırların gerçekten denendiğini ve üretilen sonucun hangi kanıtla kabul edildiğini bilir.

**İş türü ve sahip:** ilk iki kartın kapanış paketi ve mevcut beta kapıları 1/4/5/6/7/8'in kanıt eşlemesi; S6/NATIVE-BAGLAM kapıları kendi koşullarıyla sürer. Lead kanıtı birleştirir; U5 fiziksel terminal paylaşımı, bağımsız inceleme ve owner kabulü ayrı kalır. Alpha.46'dan kalan açık metinleri güncel kaynakla eşleştir; kaynakta giderilen, gerçek yüzeyde denenen ve owner tarafından kabul edilen durumları ayrı kaydet.

**Teslim içeriği:** exact SHA/paket, platform/ortam, iş ve işlem kimlikleri; gerçek yüzeyde yapılan eylem ve hedefte kalıcı sonuç; ilgili onay/kabul/etki makbuzları; olumsuz senaryoların beklenen ve gerçekleşen sonuçları; kalan sınırlar ve geri dönüş adımı. İlk çıktı/ilk kalıcı sonuç süreleri, insanın aktif emeği, gereken yardım ve ölçülebilen maliyet kaynaklarıyla raporlanır; sır veya müşteri içeriği kanıt indeksine kopyalanmaz.

**Kabul:** temiz kurulum, iş, insan girdisi, çıktı inceleme, teslim ve kurtarma aynı revision üzerinde izlenebilir. Kod işinde gerçek yama/teslim; kod dışı işte hedef kaydın sürümü ve iş koşulu kullanılır. ERP fixture'ı gerçek müşteri ERP kabulüne çevrilmez. Bağımsız inceleme, exact hosted CI ve owner beta kararı kendi kapılarında kalır.

**Sıra:** mevcut exact adayın kanıt boşluklarını belirle; ilk iki kartın yazma alanlarını ve sahiplerini çıkar; üçüncü kartın ilgili negatiflerini her davranışın adayı üzerinde çalıştır; dördüncü kartla sürüm kanıtlarını bağla. Mevcut adayın recovery kanıtı ilk iki geliştirmeyi beklemeden yürüyebilir; değişen davranış kendi adayında doğrulanır. Sabit işçi sayısı veya ölçülmemiş gün tahmini yok.

## Daha geniş adaylar ve beta sonrası sınırı

| Aday | Katkı | Önkoşul ve zaman |
|---|---|---|
| Tek MCP connector'ında OAuth ömrü | Bağlanma → yetki → ilk iş → refresh → revoke → güvenli devam. | Gerçek boşluk; token saklama, callback/kimlik ve trust/effect bütünlüğü gerektirir. Mevcut MCP-OAUTH ve A4 ile birleştirilmeli; otomatik beta çıkış koşulu değil. |
| Run başına bütçe | Tek işin scope bütçesini tüketmesini sınırlama. | Çağrı rezervasyonu, yardımcı model kullanımı, bekleyen tutar ve iptalle ortak hesap. Üst üste yeni sayaç eklenmez; kapsamı ayrıca belirlenir. |
| Genel operation geçmişi | Bekleyen/belirsiz iş etkisini kimlik ezberlemeden bulma. | PLAN “Sıradaki 10” M3 uyarınca beta sonrası ilk ERP kartı. İnsan beyanıyla kapatma M4 ayrı sorumluluk. |
| İş operasyonu onay önizlemesi | Kişi yalnız girdi özeti yerine yazılacak alanları anlayabilir. | Kaynakta gerçek eksik; genel, redakte edilebilir ve sürüme bağlı operation sunum sözleşmesi ister. İlk ERP diliminde M3/M4 ile bağımlılığı çözülür. |
| Skill/memory inceleme, geri alma | Tekrar kullanımı güvenli hale getirme. | Hermes örneği A6'ya girdi; kaynağı, kapsamı, eval ve geri dönüşü olmadan otomatik öğrenme açılmaz. |
| Desktop yönetimi, yeni kanallar, ajan organizasyonu | Geniş yönetim ve sürekli kullanım. | Mevcut A2/A3/A7 ve owner beta sonrası sırası korunur. Beta kararları Terminal'de. |

**ALMA:** sırf rakipte var diye yeni graph motoru, zorunlu şirket hiyerarşisi, connector sayı yarışı, kör retry, sessiz provider/API geçişi veya bütün etkileri geri alıyormuş gibi Git checkpoint'i. Hermes'in [checkpoint rehberi](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback) bile kapsamını dosya/çalışma alanı ve backend sınırlarıyla tarif ediyor; ERP telafisi ayrı sözleşmedir.

## Geliştirme yoluna etkisi ve ölçüm

Her rakip bulgusu için önce mevcut üretici → uygulama → adapter → yüzey zinciri bulunur. Ardından eksik türü belirlenir: mekanizma, yüzey bağlantısı, ürün kabul kanıtı veya belge güncelliği. Her biri farklı iştir; aynı yeteneğin ikinci implementasyonu açılmaz.

Önce tek tamamlanmış kullanıcı sorumluluğu, sonra daha geniş kullanım. Yeni connector veya seçenek eklendiğinde başarısızlık ve dönüş yolu da aynı dilimdedir. Operatörün komut/kimlik ezberlemesi ve elle JSON üretmesi azaltılır; yetki ve maliyet görünürlüğü korunur.

| Ölçü | Nasıl kullanılacak |
|---|---|
| İlk kullanılabilir çıktı ve ilk kabul edilmiş kalıcı sonuç süresi | Ayrı sayaçlar; kurulum/provider beklemesi ve etkin insan süresi ayrı. |
| Yardımsız yolculuk tamamlama | Aynı senaryodaki tamamlanan/denenen iş sayısı; bütün başarısızlıklar ve müdahaleler saklanır. Kullanıcı tabanı büyüklüğü değil. |
| İnsan müdahalesi | Tekrar veri girme, başka kabuğa geçme, lead yardımı ve aktif süre. Gerekli güvenlik onayı gereksiz sürtünme sayılmaz. |
| Kurtarma doğruluğu | Çift dış etki, hatalı başarı, yanlış scope ve kaybolan karar için kabul hedefi sıfır; belirsiz kayıtlar başarı paydasına eklenmez. |
| Sonuç başına maliyet | Ölçülen model/araç maliyeti, yardımcı çağrılar ve insan eforu; bilinmeyen kullanım sıfır sayılmaz. |
| Performans | Eşdeğer iş, model/araç yetkisi, sürüm ve ortamla ölç; küçük örneklemden güvenilir p95 veya ölçek üstünlüğü çıkarma. |

Bu turda bu metrikler ölçülmedi. Kullanıcı sayısını dışlamak, ürünün doğrulanabilir iş sonucu ve insan yükünü ölçmeyi dışlamaz.

## İki bakış

**Dogfood:** yeni bir geliştirme işi başlatma, işçinin sorusunu cevaplama ve doğru yamayı teslim etme için lead'in elle yaptığı adımlar azalmalı. `process-exit` yalnız o kabul kriterinin kanıtıdır; bağımsız içerik doğrulaması veya çalışan sürüme geçiş değildir.

**Hedef ürün:** müşteri ERP/CRM işleminde test paketi olmayabilir. Başarı; yetkili iş operasyonu, beklenen iş koşulu, hedefte kalıcı sonuç, gerekiyorsa insan kabulü ve telafi kanıtıdır. Git bu sözleşmenin bir adapter'ıdır; ERP ailesi ayrı Enterprise paketinde kalır. Bugün genel Core sözleşmesi bulunması, ERP adapter'larının teslim edildiği anlamına gelmez.

## Kanun kontrolü

| Kanun | Durum | Karşılık |
|---|---|---|
| 1 — Kanıt ve kapanış | Uyumlu | Kaynak, plan, gerçek kabul ve ölçülmemiş sonuçlar ayrıldı. |
| 2 — Yetki sınırı | Uyumlu | Owner'ın dört işi beta planına alma talimatı kaydedildi; dondurma istisnası, yayın veya canlı müdahale ilan edilmedi. |
| 3 — Owner iletişimi | Uyumlu | Kullanıcı etkisi, öncelik, bağımlılık ve kabul ölçütleri Türkçe. |
| 4 — Doküman ve memory | Uyumlu | Karar, PLAN, yol haritası ve ayrıntılı kartlar birbirine bağlandı; mevcut WIP korunuyor. |
| 5 — Kök neden ve iş bölme | Uyumlu | Eksik mekanizma/yüzey/kanıt ayrımı, negatif senaryolar; sabit paralellik yok. |
| 6 — Model ve provider | Uyumlu | Mevcut registry/config; fiyat/model ve sessiz ikame önerilmiyor. |
| 7 — Yerel kaynak sınırı | Uyumlu | Ürün suite/build/runtime çalıştırılmadı; belge kontrolleri ürün kabulü sayılmaz. |
| 8 — İkinci görüş | Uyumlu | Ayrı araştırma girdileri ve iki öncelik seçeneği için çevrimdışı Jev hazırlaması; danışma çağrısı, olasılık veya bağımsız PASS yok. |
| 9 — Sınır disiplini | Uyumlu | Ölçülmemiş üstünlük yok; yeni yüzey ve kapsamlı sözleşme işleri ayrıca ayrıldı. |
| 10 — Enterprise ve ERP | Uyumlu | Genel effect/approval sözleşmesi ve ayrı dağıtılan ERP adapter ailesi korunuyor. |

North star ile çatışma saptanmadı. Beta planına alınan işler mevcut sorumlulukları gerçek kullanıcı sonucuna kadar tamamlar. Plan kaydı BETA-RAKIP-1…4'ün uygulanması veya bağımsız kabulü değildir.

Belge yazar kontrolü: `node scripts/lint-arch.mjs` ve `node scripts/lint-docs.mjs`; yerel bağlantı hedeflerinin varlığı ayrıca kontrol edildi. Ürün testi, benchmark, gerçek connector/ERP işlemi veya canlı geçiş yapılmadı. Jev öncelik hazırlaması geçici `/tmp/deckent-rakip-beta-7c0sen28/` alanında; iki ayrı çekimser seçenek ve north star içeriyor, semantik doğruluk ölçümü değil.
