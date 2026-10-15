# Beta sonrası ürünleşme — Paperclip / Hermes karşılaştırma brief'i

**İş kimliği:** POST-BETA-PRODUCTIZATION-COMPARISON  
**Tarih:** 2026-10-15  
**Sahip:** ana oturum / lead; ayrıntılı dilim sahiplerini lead belirler.  
**Durum:** owner tarafından beta sonrası ele alınması istendi; araştırma girdisi ve planlama brief'i hazır. PLAN'a bağlama ve zamanı geldiğinde ayrıntılı iş planına dönüştürme ana oturumun adımıdır. Bu kayıt ürün uygulamasının başladığı veya tamamlandığı anlamına gelmez.

## Owner talimatı ve başlama koşulu

Owner, 2026-10-15 tarihli bu konuşmada Paperclip karşılaştırmasından çıkan yapılacakların; Desktop, ürünleşme, hızlı onboarding ve entegrasyon bakımından Paperclip/Hermes benzeri yapılar incelenerek beta sonrasında ayrıntılı ele alınmasını, bu dokümanın ana oturuma iletilmesini ve beta sonrası iş planına referansla alınmasını istedi.

Başlama koşulu: mevcut beta kapısı sonrasında lead'in bu iş alanını açması. Bugünkü beta kapısındaki temiz kurulum provası mevcut kapsamıyla sürer; bu brief beta öncesine yeni yüzey veya kapsam eklemez. Masaüstünün mevcut sırası, kabul edilmiş tasarım yönü ve güvenlik tabanı korunur. Ayrıntılı araştırma önce güncel kaynakları yeniler; 2026-10-15 bulguları gelecekte güncel durum gibi kullanılmaz.

Ana oturumun [PLAN.md](../../../PLAN.md) içindeki mevcut **Masaüstü** maddesine bağlayabileceği kayıt:

> **POST-BETA-PRODUCTIZATION-COMPARISON** — Owner 2026-10-15: beta sonrasında Paperclip ve Hermes gibi ürünleri kaynak ve gerçek kullanıcı yolculuğu düzeyinde incele; Desktop yönetimi, hızlı onboarding, entegrasyon ömrü, çıktı inceleme, insan müdahalesi ve güvenli yeniden kullanım için AL / UYARLA / ALMA önerileri çıkar. Bu brief'i referans al; mevcut mekanizmaları ve paralel işleri uzlaştır; her seçilen sonuç için bağımlılık, sahip, gerçek yüzey ve kalıcı sonuç kabulü belirle. İlk adım güncel kaynak/boşluk matrisi; uygulama ayrıntıları bu değerlendirmeden sonra netleşir.

## Kaynak tabanı ve kanıt sınırı

| Kaynak | İncelenen kimlik | Kanıt türü |
|---|---|---|
| Deckent Next | `7eba8b1fdf2c380fecab844a2b45dd648fe45318` | Ana dal kaynakları ve PLAN; ayrı WIP dalları teslim edilmiş sayılmadı. |
| Deckent Desktop | `6cf9bc087b1cf78c2bd7898581c589bd3169d77f` | Ayrı deponun kaynakları; README'de connect-only gözlem aşaması. |
| Paperclip | `66424362a85e80a9d8f1b1e2e94002eb1049b8ef` | UI → API → servis kaynak incelemesi, resmi belgeler; bazı geçmiş kabul raporları. |
| Hermes | İlk referans `NousResearch/hermes-agent` | Başlangıç dokümantasyon taraması; tam kaynak/çalışan ürün karşılaştırması bu işin ilerideki girdisidir. Hermes adı bu proje olarak yorumlandı. |

Bu brief için ürün runtime'ı, kurulum, test, benchmark veya canlı connector işlemi çalıştırılmadı. Screenshot/Storybook önizlemesi etkileşim kanıtı değildir. Geçmiş kabul raporu yalnız belirtilen hesap, endpoint, sürüm ve iş akışını kapsar. Müşteri sayısı, hız, güvenilirlik ve ölçek üstünlüğü ölçülmedi. Kaynakta görülen mekanizma, kullanıcı tarafından kabul edilmiş sonuçtan ayrı tutulur.

## Karşılaştırmanın başlangıç sonucu

- Paperclip doğrudan rakiptir; onboarding, ajan/görev/çıktı yönetimi, insan müdahalesi ve bağlantı kurulumu tek ürün yolculuğuna bağlanmış.
- Paperclip'in policy katmanı yüzeysel değildir: scoped yetki, sorumlu insan bağlamı, araç izinleri, onay sonrası tekrar kontrol ve bütçe rezervasyonu var. “Bizde policy var” tek başına ayrışma değildir.
- Deckent'in genel operasyon/effect sözleşmesi, belirli yürütme yollarındaki izolasyon ve mühürlü audit temeli güçlü karşılaştırma adaylarıdır. Native araç kapsamı, kurulum dışı audit doğrulaması ve gerçek ERP adapter kabulü ayrıca kanıt ister.
- Paperclip katalog genişliği bütün connector'ların güncel canlı kabulü değildir; deneysel özellikler ve sağlayıcı izinleri ayrı kontrol edilir. Hermes özellikleri de belge, kaynak bağlantısı ve gerçek kullanım kanıtına ayrılır.
- Hedef: niyet → yetkili iş → görünür ilerleme → insan müdahalesi → doğrulanabilir çıktı → kalıcı etki → kabul/teslim zincirini daha az operatör yüküyle tamamlamak.

## İncelenecek ve geliştirilecek sorumluluklar

### A0 — Güncel ürün ve rakip davranış matrisi

**Çözülecek sorun:** doküman, gelecek hedef, geliştirme dalı ve gerçek ürünün birbirine karışması.

Paperclip ve Hermes'in o günkü sürüm/commit kimliğini sabitle. Her örneği kurulum → yapılandırma → ilk iş → müdahale → çıktı → yeniden giriş/kurtarma boyunca izle. Deckent'te önce mevcut application/adapter/surface zincirini ve devam eden işi bul; aynı mekanizmayı yeniden yazma. İsim benzerliğini yetenek eşitliği sayma; Hermes ajan yürütücüsü ile Paperclip ekip yönetim katmanının sorumluluklarını ayrı göster.

**Çıktı:** kullanıcı sorunu, kaynak davranış, mevcut Deckent karşılığı, açık sınır, AL / UYARLA / ALMA, gerekçe, kazanç/kayıp, bağımlılık ve kabul kanıtı sütunlu matris. “AL” davranış örüntüsünü benimseme kararıdır; kaynak kod taşıma/lisans kararı değildir.

**Çıkış:** belge iddiası ile üretim bağlantısı ve gerçek yüzey gözlemi ayrı işaretlenmiş; seçilen ilk kullanıcı sonucu netleşmiş. Belirsiz karar için mevcut Jev yöntemi kullanılabilir; görüş PASS veya owner yetkisi değildir.

### A1 — Hızlı ve geri dönülebilir onboarding

**Paperclip örneği:** ortam kontrolü, ajan oluşturma, ilk proje/görev ve doğrudan görev konuşmasına geçiş. **Hermes araştırması:** kurulum/setup, provider seçimi, araç seçimi ve ilk oturumun ne kadar bağlam istediği.

**Deckent'te araştırılacak akış:** kurulum seçimi veya oluşturma → kimlik/scope → desteklenen provider/abonelik/yerel seçenek → gerekli bütçe ve izin özeti → ilk güvenli görev → çıktı/teslim. İnsan ilk işine ulaşmadan gereksiz organizasyon ve mimari terimlerle karşılaşmamalı; yetki, maliyet ve sonuç gizlenmemeli. Bağlantı varlığı yetki verilmesi anlamına gelmez.

Varyantlar: temiz kurulum; mevcut kuruluma bağlanma; davetli ekip üyesi; yerel model; desteklenen abonelik; ücretli API; ağ/kimlik doğrulama kesilmesi; yarıda bırakıp yeniden açma. Desteklenmeyen platform/provider açıkça belirtilir. Varsayılanlar registry/config'den gelir; sır yalnız uygun maskeli/secret-store yolundan alınır.

**Çıkış:** kapsamda seçilen varyantta lead yardımı olmadan ilk gerçek ve kabul edilmiş sonuç; yarım kurulumu güvenli sürdürme; red/iptal/yanlış scope durumlarında yetkisiz etki yok. Başarısızlık sonraki eylemi ve sorumluyu gösterir. İlk sohbet yanıtı ile ilk kalıcı iş sonucu ayrı ölçülür.

### A2 — Desktop'ta tam yönetim yolculuğu

**Paperclip örneği:** görev merkezli çalışma, contextual detail, müdahale kutusu ve çıktı inceleme. Mevcut Deckent Graphite Operations / Basic-Advanced Desktop yönünü yeniden açmadan bu davranışlardan öğren.

Desktop'tan iş başlatma, durumu ve bekleme nedenini anlama, doğru Run/Task/Attempt'i seçme, yetkili onay, pause/resume/cancel, gerektiğinde kullanıcı girdisi ve teslim zincirini mevcut tek typed application contract üzerinden bağla. Dashboard gözlem rolünde kalır. Renderer yeni policy, kimlik, state veya kabul otoritesi olamaz.

Kimlik, ilerleme, son anlamlı değişiklik ve bir sonraki güvenli eylem sakin ana yüzeyde; ayrıntılı authority/evidence/resource bilgisi bağlamsal detayda gösterilir. Seçim yenilemelerde nesne kimliğiyle korunur. `unknown`, `cancelled`, `incomplete`, `accepted`, `delivered`, `settled` anlamları kaybolmaz.

**Çıkış:** başarılı ve kesintili gerçek iş akışları; reconnect/stale/partial veri; klavye ve focus geri dönüşü; TR/EN; desteklenen Windows/WSL, Linux ve diğer platformların ayrı kanıtı. Sahte veri veya yalnız gözlem yüzeyi tam yönetim kabulü sayılmaz.

### A3 — İnsan dikkatini ve karar yükünü azaltma

**Paperclip örneği:** What Needs Me, review/approval ve karar sonrası işin devamı.

Bekleyen onay, ihtiyaç duyulan bilgi, başarısızlık, belirsiz dış etki ve teslim beklemesini iş etkisine göre görünür yap. Her beklemede sorumlu, neden, yaş/tazelik, zaman sınırı ve yetkili sonraki eylem bulunmalı. Bildirimi kapatma veya erteleme iş durumunu değiştirmez. Kararın hangi exact çağrıya ait olduğu ve karar sonrası ne olduğu görünür kalır.

**Çıkış:** onay iptali/süre dolması, karar sırasında policy değişmesi, hedef/argüman değişmesi, çift tıklama, bağlantı kopması ve devam edemeyen iş için gerçek yüzey + kalıcı kayıt bağı. Tek bir kullanıcı kararının çok sayıda gereksiz bildirim üretmediği ölçülür.

### A4 — Entegrasyonun bütün ömrünü ürünleştirme

**Paperclip örneği:** app katalog → hesap bağlama → insan/ajan seçimi → Off/Ask first/Allowed → görev → reconnect/disconnect. **Hermes araştırması:** toolsets/MCP ve mesajlaşma yüzeylerine bağlanma akışının sade tarafları.

Seçilecek ilk connector ailesinde keşif, gereksinim, OAuth veya anahtar, scope, araç yetkisi, sağlık kontrolü, ilk görev, token yenileme, erişim geri alma ve kaldırmayı tamamla. MCP-OAUTH ve mevcut provider/secret/approval işleriyle birleştir; ikinci credential veya effect sistemi kurma. Yayımlanan araç tanımı değiştiğinde güven/onay davranışını belirle.

Katalog kaydı, kurulumun tamamlanması, araç çağrısı ve iş sonucunun kabulünü ayrı durumlar olarak göster. Read/write ve upstream hesap yetkisi kullanıcıya anlaşılır biçimde açıklansın. Dış sağlayıcının reddi ya da erişim kısıtı boş başarıya dönüşmesin.

**Çıkış:** desteklenen connector'da bir gerçek iş ve gerekli negatif yollar; sırların UI/worker/log'a sızmaması; bağlantı kopması sonrası çift etki oluşmaması. Genel MCP'nin sağlayamadığı idempotency/lookup/telafi açıkça görünür kalır; logo sayısı başarı ölçütü değildir.

### A5 — Çıktı inceleme, düzeltme ve kabul

**Paperclip örneği:** görev çıktısını inceleme belgesine dönüştürme, revision ve bağlamlı yorumlar.

Kod diff'i yanında rapor/doküman ve kod dışı iş sonucunu gerçek artifact/operation kanıtına bağla. Yorum, değişiklik isteği, yeniden sunma ve kabulün hangi revizyona ait olduğunu koru. Agent'ın “bitti” demesi, dosya oluşması veya process exit tek başına kabul değildir. Genel kabul kriterleri Git adapter'ına gömülmez.

**Çıkış:** seçilmiş kod ve kod dışı yolculukta kullanıcı çıktıyı inceleyip gerekçeli karar verir; stale artifact/revision, yetkisiz içerik okuma ve eksik kanıtın kabul edilmediği gösterilir. Otomatik düzeltme/retry kapsamı mevcut owner kararlarıyla uzlaştırılır.

### A6 — Skill, hafıza ve tekrar kullanılabilir çalışma düzeni

**Paperclip örneği:** ekip/skill paketleri ve güvenli import. **Hermes araştırması:** oturum devamlılığı, geçmişten retrieval ve skill üretme/kullanma deneyimi.

Tekrar eden işi başlatma maliyetini azaltmak için sürümlü skill ve iş şablonlarını mevcut registry, scope ve kabul sınırlarıyla değerlendir. Kullanıcı öğrenilen bilginin kaynağını, kapsamını, paylaşımını ve silme/geri alma etkisini anlayabilmeli. Modelin ürettiği skill önerisi otomatik güvenilir paket veya yetki yükseltmesi değildir.

**Çıkış:** aynı işi tekrar başlatırken ölçülmüş kullanıcı kazancı; yanlış/eski hafıza, scope dışı retrieval, prompt injection, paket yükseltme ve geri alma yolları. Sessiz müşteriler arası öğrenme yok; kritik karar kaydı geçmiş sohbetten ayrı.

### A7 — Sürekli kullanım, kanallar ve kurulum bakımı

**Paperclip örneği:** routines, webhook, maliyet/çıktı geçmişi. **Hermes araştırması:** messaging gateway, scheduled work, session continuity ve operasyonel tanılama.

Mevcut Mission/Run/Task/Attempt, scheduler ve admission sorumlulukları üzerinden tekrarlı işe dönüş, mesajdan işe geçiş ve görünür maliyet değerlendirilir. Zamanlama yeni yetki üretmez. Mesajlaşma hesabı ile doğrulanmış insan principal eşlemesi, çift event, geç gelen cevap, iptal ve belirsiz gönderim açıkça modellenir. Yanıtı bir kanala göndermek ayrı dış etkidir.

Kurulum tarafında upgrade/rollback, bağlantı tanılama, backup/recovery ve desteklenen platform sınırlarını ilk kullanımdan sonra da anlaşılır tut. Deneysel bir özelliği kapatmanın çalışan işe, yeni işe ve saklanan veriye etkisi ayrı gösterilir.

**Çıkış:** seçilen geri dönüş/tekrarlı iş akışının yeniden başlatma ve bağlantı kesilmesiyle kanıtı; gerçek iş sonucuna ulaşma ve operatör yükü ölçümü. Yeni scheduler veya ikinci durum sahibi oluşturulmaz.

## Bağımlılıklar, sahiplik ve mevcut işlerle birleşme

- A0 güncel matrisi önce gelir. A1, A2 ve A4 için ortak kimlik/config/secret/policy bağımlılıkları ve tek yazar sahipliği lead tarafından çıkarılır.
- A3, A2'nin müdahale davranışıyla; A5, mevcut artifact/evaluation/effect/teslim sözleşmeleriyle birlikte ilerler. Aynı UI veya application dosyalarına paralel yazar atanmaz.
- A6 ve A7'nin uygulama sırası A0 kazanç/kayıp değerlendirmesinden çıkar. Örneğin hafıza veya yeni mesaj kanalı, ilk iş/teslim yolculuğunu geciktirecekse gerekçesiyle sonraya bırakılır.
- Mevcut BETA-BELGE, ILK-KAYIT, SIWC-CORE, NATIVE-BAGLAM, MCP-OAUTH, politika yönetimi, AUDIT-CHECKPOINT, M5 hafıza/ajan işleri ve AJAN-ORG-DESKTOP analizi yeniden kontrol edilir; örtüşen kapsam ayrı kart olarak tekrarlanmaz.
- Desktop, Core ve connector/Enterprise sahipleri sorumluluklarını ayırır; hangi sözleşmenin değişeceği varsa mevcut architecture üzerinden en küçük gerekçeli amendment sunulur.
- Worker sayısı/model/paralellik bu brief'te sabitlenmez; admitted DAG, disjoint yazma alanı ve ölçülmüş kapasiteden belirlenir.

## Eşit koşullarda değerlendirme ve kabul paketi

Rakipler aynı işi destekliyorsa eşdeğer hesap, model sınıfı, araç erişimi, veri, başlangıç koşulu ve kullanıcı deneyimiyle karşılaştır. Desteklemiyorsa zorla eşitleme; kapsam farkını kaydet. Gerçek sağlayıcı/hesap kurulumu ve yazma işlemleri ilgili yetki sınırı içinde ayrıca yapılır. Genel hız puanı veya uydurma hedef süre üretme.

| Ölçü | Tanım ve dikkat |
|---|---|
| İlk kullanışlı sonuç süresi | Temiz başlangıçtan kullanıcının yararlanabildiği ilk çıktıya; kurulum ve provider beklemesi ayrıca görünür. |
| İlk kabul edilmiş kalıcı sonuç süresi | Gerçek kriter/effect/teslim kanıtı olan ilk sonuca; ilk chat cevabından ayrı. |
| Yardımsız tamamlama | Kapsamı belirtilmiş denemelerde lead müdahalesi olmadan tamamlanan yolculuk oranı; payda ve başarısızlıklar saklanır. |
| Operatör yükü | Manuel karar, tekrar veri girişi, teknik yardım ve aktif insan süresi; gerekli güvenlik onayı gereksiz sürtünme sayılmaz. |
| Bağlantı ve kurtarma | İlk bağlantı başarısı, yeniden giriş/kurtarma süresi, belirsiz effect yaşı, çift işlem sayısı. |
| Durum doğruluğu | Gerçek ledger/receipt ile yüzeyin eşleşmesi; unknown/stale/partial verinin yanlış başarıya dönüşmemesi. |
| Maliyet | Kabul edilen sonuç başına ölçülebilen model/araç maliyeti ve insan eforu; bilinmeyen fatura sıfır yazılmaz. |
| Erişilebilirlik ve platform | Klavye/focus, ekran okuyucu, zoom, dar ekran, TR/EN ve desteklenen OS kombinasyonları ayrı kanıt. |

Kabul paketi her sonuç için exact revision, ortam/workload, producer → application → adapter → yüzey bağı, ham kanıt, negatif yollar, mevcut açıklar ve geri dönüşü içerir. Yazar doğrulaması, bağımsız inceleme, hosted/live kabul ve owner kabulü ayrı kaydedilir. A0 araştırma raporu ürün kapanışı değildir.

## İlk kaynaklar — Paperclip ve Deckent

Paperclip bağlantıları 2026-10-15 inceleme commit'ine sabittir:

- [İlk proje/görev ve konuşmaya geçiş](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/ui/src/components/OnboardingWizard.tsx#L1719-L1789).
- [İnsan müdahalesi ve erteleme/geri alma](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/ui/src/pages/WhatNeedsMe.tsx#L426-L456).
- [Çıktı inceleme](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/ui/src/components/issue-properties/IssuePropertiesArtifactsTab.tsx#L78-L128).
- [Araç izinleri](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/ui/src/pages/apps/app-detail/PermissionsPanel.tsx#L446-L454), [onay sonrası güncel hedef ve argüman kontrolü](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/server/src/services/tool-gateway.ts#L10441-L10523).
- [Bütçe rezervasyonu](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/server/src/services/budget-reservations.ts#L8-L68), [belirsiz mutation sonucu](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/server/src/services/public-mcp/capabilities.ts#L184-L206).
- [Güncel connector rehberi](https://docs.paperclip.ing/connectors/): yaşayan belge, işe başlarken yenilenecek. Katalogda bulunma, provider girişinin hazır olduğu anlamına gelmez; Google doğrulama ve aggregator sınırları başlangıç incelemesinde açıktı.
- [Tarihsel MCP kabul raporu](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/doc/connections/REMOTE-MCP-LIVE-ACCEPTANCE.md#L15-L22): seçili geçmiş akışlar; güncel genel kabul değildir.
- [Deneysel varsayılanlar](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/server/src/services/instance-settings.ts#L278-L300), [plugin güven sınırı](https://github.com/paperclipai/paperclip/blob/66424362a85e80a9d8f1b1e2e94002eb1049b8ef/doc/plugins/PLUGIN_AUTHORING_GUIDE.md#L3-L22).

Deckent başlangıç referansları: [PLAN](../../../PLAN.md), [architecture](../../../ARCHITECTURE.md), [tasarım kararları](../../../.agents/skills/deckent-design-dna/references/current-owner-decisions.md), [effect uygulaması](../../../src/engine/core/effect/internal/application.ts), [MCP effect sınırı](../../../src/adapters/core/mcp-client/internal/target.ts), [audit mühürleme](../../../src/engine/core/audit/internal/integrity.ts), [extension entry](../../../src/extensions.ts). Desktop için ayrı `deckent-desktop` deposunun `README.md`, `shell/src/connector.ts` ve `contract/` kaynakları güncel revizyonla yeniden okunur.

## İlk kaynaklar — Hermes ve araştırılacak farklar

Hermes başlangıç referansı [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) olarak doğrulandı. Aşağıdakiler 2026-10-15 erişimli resmi dokümantasyon bulgularıdır; çalışan kurulum veya tam kaynak audit'i yapılmadı. Beta sonrası başlamadan sürüm/commit sabitlenir ve belge iddiaları gerçek consumer yoluyla doğrulanır.

- [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart): Desktop/CLI kurulum, provider seçimi, ilk gerçek araç kullanımı ve oturuma geri dönme örneklerini incele. Quick/Full/Blank Slate kurulum seçeneklerinin ilk iş başarısına katkısını ölç; Deckent'te tek güvenlik ve durum modeli üzerinden kademeli ayrıntı göster.
- [Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging): kaydedilmiş credential, çalışan gateway ve bağlı kanal ayrımını; duraklatma, yeniden başlatma ve kesinti dilini incele. Kanal değiştirmek principal veya onay yetkisi kazandırmamalı; aynı iş kimliği korunmalı.
- [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills): gerektiğinde yüklenen prosedür, kaynak bilgisiyle kurulum ve isteğe bağlı pending skill değişikliklerinin diff/approve/reject deneyimini araştır. Öğrenilmiş öneri ile kabul edilmiş etkin skill sürümünü ayır; kapsam, eval ve geri alma kanıtını iste.
- [Tool Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-gateway): merkezi girişle araç kurulumunu sadeleştirme ve çoklu hesap seçiminde belirsizliği açık ret ile çözme örneklerini araştır. Abonelik/managed servis kolaylığı ile bağımsız ve air-gapped Core koşulları ayrı değerlendirilir; bu belge Deckent için hizmet bağımlılığı seçmez.
- [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security): komut onayı, timeout, mesajlaşma yetkisi, MCP credential filtering ve terminal backend sınırlarını kaynakta doğrula. Shell deny listesi OS izolasyonu sayılamaz; yardımcı LLM kararı Deckent'te deterministik yetki kapısının yerine geçemez. Container backend'ine göre atlanan kontroller varsa mevcut Deckent tabanını gevşetmeden karşılaştır.

Öğrenme hipotezi: Paperclip ekip/iş/entegrasyon yönetimini, Hermes kişisel ajan kurulumu ve oturum sürekliliğini farklı ağırlıklarla ele alıyor. Bu rol ayrımı başlangıç çerçevesidir; hangisinin hangi işi daha iyi çözdüğü eşdeğer senaryoyla ölçülecek.

## İki bakış

**Dogfood:** Deckent'in kendi geliştirme işinde ilk kurulum, ajan koordinasyonu, müdahale, değişiklik inceleme ve güvenli teslim operatör yükünü azaltmalı. İzole aday üretimi, kabul ve çalışan sürüme geçiş birbirinin yerine geçmez; host geliştirme araçları ürün yeteneği sayılmaz.

**Hedef ürün:** müşteri ERP/CRM, araştırma, içerik ve operasyon işlerinde aynı kaliteyi görmeli. Kabul modeli genel kriter ve kalıcı iş kanıtıdır. Git/test bu modelin bir adapter'ıdır; kod dışı işi kod testine çevirmek çözüm değildir. Enterprise/ERP ayrı paketleri Core'u fork etmeden ortak operation/approval/effect sözleşmelerini kullanır.

## Kanun kontrolü

| Kanun | Durum | Bu brief'teki karşılık |
|---|---|---|
| 1 — Kanıt ve kapanış | Uyumlu | Kaynak, geçmiş kanıt, gerçek yüzey ve kalıcı kabul ayrı; test yeşili kapanış değil. |
| 2 — Yetki sınırı | Uyumlu | Owner beta sonrası planlama istedi; beta öncesi uygulama/live kapsamı açılmadı. |
| 3 — Owner iletişimi | Uyumlu | Kullanıcı sonucu, açık sınır, sahip ve sonraki adım sade Türkçe. |
| 4 — Doküman/memory | Uyumlu | Bu dosya plan girdisi; PLAN bağını main kurar, core-memory değiştirilmez. |
| 5 — Kök neden/paralellik | Uyumlu | Yolculuk boşlukları ve bağımlılıklar esas; sabit worker sayısı yok. |
| 6 — Tek kaynak | Uyumlu | Model, fiyat ve politika registry/config'den; sessiz ikame yok. |
| 7 — Kaynak sınırı | Uyumlu | Bu hazırlıkta ürün testi/build yok; sonraki doğrulama mevcut kaynak sınırlarıyla. |
| 8 — İkinci görüş | Uyumlu | Araştırma, Jev ve yazar kontrolü bağımsız PASS sayılmaz. |
| 9 — Sınır disiplini | Uyumlu | Hermes ön taraması ve gelecekteki ölçümler açık; kanıtsız hız/üstünlük yok. |
| 10 — Enterprise/ERP | Uyumlu | Genel sözleşme, ayrı adapter ailesi ve kod dışı kabul korunur. |

North star ile çatışma saptanmadı. Kalite hedefi daraltılmadan, mevcut mekanizmalar üzerinden tamamlanan kullanıcı sorumlulukları öneriliyor.
