# Deckent sözlüğü

[English](glossary.md) · [Mimariye genel bakış](architecture-overview.tr.md) · [README](../README.tr.md)

Bu terimler ürün davranışını açıklar. Bir kimlik, persona ya da izin modu tek başına erişim
vermez; kimlik ve yetki politikası denetimleri her zaman geçerlidir.

## Kapsam (scope)

Bir işlemin veri ve yetki sınırını belirleyen kimliktir. Yetki politikası, onay kayıtları,
yürütmeler ve harcama hesapları kapsama bağlıdır. `--scope my-project` bu kimliği seçer;
bir dosya yolu değildir ve işletim sistemi düzeyinde yalıtım oluşturmaz.

Yeni kişisel projenizde ilk yetki politikasını önizlerken `my-project` gibi sabit bir kimlik
seçin. Politikayı uygularken ve bütçeyi yönetirken aynı kimliği kullanın. Mevcut kurulumda
ayarlarında tanımlı kapsam kimliğini kullanın. Terminalin varsayılanı `terminal.scopeId` değeridir;
`deckent --scope my-project` bu kapsamı açıkça seçer. [İlk oturum örneğine](../README.tr.md#adım-adım-ilk-oturum) bakın.

Hedeflenen kuruluş hiyerarşisi kurulum → şirket → isteğe bağlı tesis/birim → proje → oturumdur.
Kurulum barındırma ve güven sınırıdır; şirket bir veri kapsamıdır. Bu, mimari yöndür;
tüm yönetim yüzeylerinin bugün sunulduğu anlamına gelmez.

## Yürütme ortamı (realm)

İşlemin çalıştığı, dosya sistemi, süreç ve ağ kısıtlarını içeren yapılandırılmış ortamdır.
Kabuk ortamı kayıtlı bir yalıtım uygulamasını ve yalıtım tutumunu seçer. Kapsam hangi işe
erişebileceğinizi, yürütme ortamı ise işin nerede ve nasıl çalışacağını sınırlar.

`require-sandbox`, yalıtım sağlanamazsa çalışmayı reddeder. `prefer-sandbox` ana makinede
çalışabilir; bu durum onay kartında görünür. Docker işçileri kendi konteyner ayarlarını
kullanır ve ana makinenin çekirdeğini paylaşır.

## Yürütme, görev ve deneme (run, task, attempt)

- **Yürütme (Run):** bağımlılıkları, sınırları ve genel sonucu olan bir görev grafiğinin kabul edilmiş yürütülmesidir.
- **Görev (Task):** bu grafikte girdisi ve kabul ölçütleri bulunan bir iş birimidir.
- **Deneme (Attempt):** görevin işçiye, çalışma alanına ve saklanan kanıta bağlı tek çalıştırma denemesidir.

Yeniden deneme politikası izin verirse bir görevin birden çok denemesi olabilir. İşçinin
sonlanması yalnız çalıştırma gözlemidir; işin kabulü ve teslimi ayrı adımlardır. Yürütme karar
veya kanıt beklerken duraklatılabilir. Eksik kanıt başarı değil, bilinmeyen sonuçtur;
belirsiz bir dış etki körlemesine tekrar edilmez.

## Onay kartı (approval card)

Bekleyen onay isteğinin terminaldeki görünümüdür: eylem veya komut, yer, işlemi yapan kimlik,
kapsam, gerekçe, risk, geri alınabilirlik ve süre sonu. İstek ve yetkili karar kalıcı kayıtlardır;
kart bu kayıtları gösterir. Sürenin dolması ya da pencerenin kapanması onay vermez.
MCP yüzeyi onayları listeler ve inceler; onay kararı veremez.

## Değişmez koruma sınırı (hard floor)

İzin modunun gevşetemeyeceği korumalardır. Deckent ayarları, yetki politikası, onaylar,
sırlar ve MCP kaydı hassas yollar ve işlemler arasındadır. İşleme göre açık onay gerekir
veya hassas durum yürütmenin görebildiği alanın dışında tutulur. Kolaylık sağlayan modların
kendi yetkisini değiştirmesini önler. Aynı işletim sistemi hesabıyla çalışan diğer programların
erişebildiği tüm dosyaların korunduğu anlamına gelmez.

## Tam erişim (full access)

Yalnız şirket politikasının izin verdiği, oturumla sınırlı bir izin modudur. Kabuk görünümünü
ana makine dosyaları, ev dizini, ağ ve Git yazmaları için genişletir; korunan durum maskelenir
ve etki çağrıları denetim kaydına girer. Açık retler ve değişmez koruma sınırı geçerliliğini
korur. **Tam otomatik (full auto)** modundan daha geniştir: tam otomatik yalnız yalıtımın
kapalı görünümündeki uygun çağrıları otomatikleştirir.

## Bütçe (budget)

Ücretli model çağrılarının gönderilmeden önce pay ayırdığı USD üst sınırıdır. Mevcut API model
yolu kapsam başına tüm sağlayıcıların paylaştığı tek bütçe kullanır. Hesap üst sınırı, ayrılan
ve kesinleşen tutarları ayırır. Bütçe veya kullanılabilir tutar yoksa yeni ücretli çağrı
reddedilir. İptal edilen ya da kesilen çağrı, uzlaştırılana kadar ayrılan tutarı tutabilir.
Bu Deckent'in çağrı kabul denetimidir; sağlayıcı hesabındaki sınır veya fatura değildir.

## Ölçülen kullanıma dayalı tarife (measured tariff)

Sağlayıcının bildirdiği nihai kullanım ile sabitlenmiş yayımlanmış veya beyan edilmiş sürümlü
tarifeden hesaplanan ücrettir. Kayıt kullanım boyutlarını, fiyat kademesini ve tarife kimliğini
taşır; hesap kesin aritmetik kullanır. Sağlayıcının bildirdiği para değil, kullanım × tarifedir.
Üst sınır kademesi açıkça belirtilir. Nihai kullanım eksikse kayıt çözümlenmemiş kalır;
sıfır ya da ara tahminle doldurulmaz.

## Kalıcı işlem kaydı (ledger)

İşlerin, ayrılan kaynakların, kararların, etkilerin ve makbuzların kalıcı işlemsel kaydıdır.
Mevcut uygulama SQLite kullanır. Şema sürümü veri biçimini ve geçiş gereksinimini tanımlar;
paket sürümünden ayrıdır. Denetim mühürleri bütünlük denetimini destekler; yerel depolama,
ele geçirilmiş bir ana makineyi güvenilir yapmaz.

## Protokol (protocol)

Deckent istemcileri ile yerel yürütme servisi arasındaki sürümlü mesaj sözleşmesidir. Tipli
komut, sorgu, olay, hata ve sonuçları taşır. Protokol sürümü, ledger şeması ve paket sürümü
ayrı kimliklerdir. Yaşam döngüsü uyumluluğu eski bir servisi tanımlamaya veya durdurmaya izin
verebilir; uyumsuz istemciyle iş yürütmeye izin verdiği anlamına gelmez. Normal kullanımda
istemci ve servis için eşleşen build'ler kullanın.

## İşlemi yapan kimlik ve yetki politikası (principal, policy)

**Principal**, adına işlem yürütülen doğrulanmış kişi veya süreçtir. **Policy**, bu kimliğin
bir kapsamdaki kaynak üzerinde eylem yapmasına izin verir, reddeder veya onay gerektirir.
Kapsam üyeliği tek başına yeterli değildir. Model, persona veya eklenti kendisine yetki veremez.
