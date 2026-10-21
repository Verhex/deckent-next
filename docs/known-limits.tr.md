# Bilinen sınırlar

[English](known-limits.md) · [README](../README.tr.md) · [Mimariye genel bakış](architecture-overview.tr.md)

Bu sayfa Deckent'in henüz neyi yapmadığını, neyin denenmediğini ve onun yerine ne yapmanız gerektiğini açıkça söyler.
Sayfa güncel ön sürümü anlatır (sürüm [README](../README.tr.md) içinde ve [CHANGELOG](../CHANGELOG.md) dosyasının ilk satırındadır). Bir sınır bu sayfadan ancak onu kapatan değişiklik indiğinde ve
çalıştığı görüldüğünde çıkar, daha önce değil. Her madde sınırın **ne** olduğunu, size **etkisini** ve varsa bir
**yolunu** verir. [CHANGELOG.md](../CHANGELOG.md) her sürümün o günkü sınırlarını listeler.

Deckent bir ön sürümdür. Buradaki hiçbir şey tarih vaadi değildir.

## Platformlar: denenenler ve denenmeyenler

- **Denenen:** Linux ve WSL2 üzerinden Windows (desteklenen yürütme yolu). Barındırılan (hosted) kontroller Ubuntu'da Node 24 ve
  Node 26 ile çalışır. Node.js 24.22.0 veya daha yenisi gerekir (24.21 ve eski 24.x sürümlerinde UTF-16LE çözümlemede heap taşması vardır).
  *Etki:* davranışın gözlendiği tek yerler bunlardır.
- **Desteklenmeyen: native Windows runtime.** Servis taşıması orada çalışmaz ve dosya tabanlı gizli depolar orada yoktur.
  İşletim sistemi kullanıcı kimliği okunamaz ve özel ledger dosyaları açılamaz; bu yüzden yedekleme, izleme ekranı, model
  çağrıları, Brain ve iş kabulü de native Windows'ta çalışmaz. Platform testleri bunları `[unsupported on Windows: …]`
  etiketiyle atlar; Windows kontrolünün yeşil olması bu parçaların çalıştığı anlamına gelmez. *Yol:* WSL2 kullanın.
- **macOS'un doğrulaması ayrı ve eksiktir.** Zorunlu kontrollerin parçası değildir. *Etki:* orada yürütme ve güvenlik davranışı
  kanıtsızdır; gerçek iş için buna güvenmeyin. Yerel runtime soketi yalnız Linux'tadır; bu yüzden servis taşıması, yedekleme ve
  geri yükleme macOS'ta da çalışmaz; platform testleri bunları `[requires Linux …]` etiketiyle atlar.
- **Terminal ekran düzeni** fiziksel Windows Terminal, macOS Terminal, VS Code terminali ya da tmux'ta **denenmedi.**
  *Etki:* giriş çubuğu, pencereler ve renkler orada bozulabilir. *Yol:* düz bir Linux ya da WSL2 terminali kullanın.
- **Fareyle kopyalama terminalinizin pano dizisini (OSC 52) kullanır** ve yalnız bir Linux sözde-terminalinde kanıtlandı; fiziksel
  Windows Terminal, onun içindeki WSL, xterm, tmux ya da iTerm2'de denenmedi. Bazı terminaller bunu engeller (iTerm2'de "Applications in
  terminal may access clipboard" açılmalı; tmux'ta `set -g set-clipboard on` gerekir). Sürükleyerek seçimde otomatik kaydırma ve çift/üçlü
  tıklama yok. *Etki:* "… karakter panoya kopyalandı" sonrasında yapıştırma boş gelebilir. *Yol:* Shift'e (iTerm2'de Option) basılı tutup
  sürükleyerek terminalin kendi seçimini kullanın ya da `terminal.layout` değerini `inline` yapın.
- **arm64 yayımlanmıyor.** Kilitli bubblewrap paketi x86_64 için gelir; arm64 derleme kontrolü arm64 çalışma kanıtı değildir.
  *Yol:* x86_64 kullanın.
- **Henüz npm paketi yok.** Kaynaktan kurarsınız ([Başlarken](../README.tr.md#başlarken)).
- **Bazı kurulum mesajları yalnız İngilizce** (derleme ve sandbox hazırlığı mesajları çeviri var olmadan önce çıkar).
- **`deckent init` kurulumu yapar, henüz ilk kodlama Run'ını değil** (alpha.48 I-S3). İlk kurulum izinlerini, dili,
  sandbox kontrolünü, Docker kurulumunu (yalnız kişi), model bağlantısını (`models connect`), proje yönergelerini ve son
  kontrolü, her birini kendi mevcut komutuyla uygular. *Etki:* kurulum worker imajını oluşturmaz, kaydı ve havuzu yazmaz:
  özeti (ve `deckent init --json`, `firstJob`) ilk iş için eksik adımları sırayla ve tam komutlarıyla listeler (kaynak kodda
  `npm run worker:image` ile worker imajı, `deckent config set execution`, `deckent init registry`, `deckent init pool`), doctor'un
  havuz satırı ilkini gösterir; liste yalnız yapılandırmayı ve havuz defterini okur, ayarlı imajın makinede olup olmadığını
  denetlemez; teslim klonu da kurulum aşaması değildir.
  Seçtiğiniz profil (tek kullanıcı, ekip, kurum ya da özel) kullanıcınızın genel yapılandırmasına kaydedilir
  (`identity.profile`; dağıtım `deckent identity distribute` olarak kalır); sonraki `deckent init` onu geri okur ve aşamayı tamam
  gösterir, doctor da artık profil istemez. Gözetimsiz `--yes` profili kaydetmez. Son kontrol
  doctor'ın kendi satırlarıdır: yalnız hiç uyarı yokken ve diğer her aşama tamam ya da atlanmışken "tamam" olur; bu yüzden
  yeni kurulumda "uygulanmaya hazır" kalır (doctor worker havuzu için uyarır ve ilk iş için eksik ilk adımı
  gösterir; yalnız `--yes` sonrasında kimlik profilini de ister). Gözetimsiz `deckent init --yes --scope <kimlik>` yalnız yeni izinleri, dili ve son kontrolü uygular.
- **Kurulumdan Docker Engine kurmak yeni** (alpha.48 I-D2; I-S3'ten beri `deckent init` penceresinde, yalnız gerçek bir
  terminaldeki kişiye önerilir). Yalnız Docker'ın resmi apt deposundan, Docker'ın listelediği Ubuntu ve Debian sürümlerinde
  (2026-10-19'da kontrol edildi), Deckent ile gelen Docker imza anahtarıyla kurar; geri kalan her durumda (yerel
  Windows/macOS, WSL'de Docker Desktop, Linux Mint gibi türevler, çakışan `docker.io`/`containerd`/`runc` paketleri, eski bir
  `docker.list`, ağ yok) yalnız sonraki adımı yazar. *Etki:* gerçek kurulum yalnız kayıt tutan sahte bir `sudo` ile
  prova edildi; Deckent testleri onu hiç çalıştırmaz. Docker anahtarını değiştirirse apt depoyu yeni anahtar bir Deckent
  güncellemesiyle gelene kadar reddeder (güvenli tarafta kapanır). Anahtar ve kaynak dosyaları `$TMPDIR` altında özel bir
  klasörde hazırlanır; reddedilen ya da yalnız yazdırılan bir çalıştırmadan sonra orada kalır. systemd'siz WSL'de motor
  kurulumdan sonra başlamayabilir; sonraki kontrol hizmetin durduğunu söyler. WSL'deki Docker Desktop denetimi Windows
  tarafındaki programa bakar (gözlenen bir düzen, belgelenmiş bir sözleşme değil). Terminal tanığı ret metni bu kurulumu
  henüz adıyla anmıyor. Kurulum sürerken pencere kapanır (sudo düz terminalde sorar) ve sonra yeniden açılır. *Yol:* yazılan komutları izleyin, hizmeti başlatın, `docker` grubu için oturumu kapatıp açın.

## Yalıtım

- **Docker görevleri, bellek sınırlarının %75'i kadar Node heap tavanı alır.** Deckent `NODE_OPTIONS=--max-old-space-size` ayarlar;
  böylece Node tabanlı kontroller (ör. `tsc`) konteynerin belleğini kullanır. Görev komutu `NODE_OPTIONS`'ı kendisi ayarlarsa o geçerlidir;
  imajın kendi ortamında ayarlanan `NODE_OPTIONS` ise ezilir. Aynı konteynerdeki birden çok Node süreci sınırı paylaşır ve yine de
  sınırda durdurulabilir (çıkış 137).
- **Docker işçisi sanal makine değildir.** Host çekirdeğini paylaşır. *Etki:* çekirdek düzeyinde bir kaçışı Deckent
  sınırlamaz. microVM sandbox'ı planlıdır, yapılmadı.
- **Kodlama işçisinin kendi araçları Deckent'in model giriş yolunun dışındadır.** Claude Code, Codex ve Cursor konteyner
  içinde kendi araçlarını kullanır. *Etki:* bu araç çağrılarına Deckent'in çağrı başına onay pencereleri karar vermez; onları
  konteyner, çalışma kopyası ve teslim kapısı sınırlar. *Yol:* işçilere yalnız çalışma kopyasını ve işin gerektirdiği izinleri verin.
- **Ubuntu 24.04 ve sonrası sandbox'ı engelleyebilir.** `kernel.apparmor_restrict_unprivileged_userns` `1` ise bubblewrap
  başlayamaz; Deckent görünür biçimde Landlock'a düşer ve tam erişimli kabuk çağrılarını reddeder. *Yol:* bir yönetici
  bubblewrap'ı root sahipli `/usr/local/bin/bwrap` olarak, ona `userns` izni veren bir AppArmor profiliyle kurar
  ([Başlarken](../README.tr.md#başlarken)).
- **Yalnız Landlock olan bir host'ta büyük bir `.gitignore` klasörü kabuğu durdurabilir.** Landlock artık `.gitignore`'da adı
  geçen klasörlerde de bubblewrap gibi kimlik bilgisi dosyası arar; bu yüzden bu klasörler 20.000 girdilik sınırına sayılır
  (bubblewrap: 50.000). *Etki:* sınırı aşan bir projede kabuk çalışmaz, görünür bir nedenle reddedilir. *Yol:* bubblewrap'ı
  kullanılabilir yapın ya da büyük üretilmiş klasörleri proje klasörünün dışında tutun.
- **`prefer-sandbox` host yedeğinin zorlanan bir dosya sistemi sınırı yoktur.** Kapalı modlarda kullanılabilir sandbox
  yoksa çağrı host'ta çalışabilir. *Yol:* sınırlama gerekiyorsa `require-sandbox` seçin.
- **Kimlik bilgisi ve ev dizini gizleme sınırlıdır.** Ortak kayıt gh, Docker, kube, Codex, Git kimlik bilgileri ve yaygın
  bulut CLI'larını kapsar; gizleme 3 derinlikte ve 20.000 girdide durur. *Etki:* özel konumlar ve olağandışı dosya adları
  maskelenmez. *Yol:* böyle dosyaları sandbox'ın gördüğü ev dizininin dışında tutun ya da ayrıca yalıtın.
- **Sırrı yalnız kurulum ayarı adlandırabilir.** Proje ayarındaki (`.deckent/config.json`) bir `$DECK:NAME` referansı ayarın
  yüklenmesini `SECRET_REFERENCE_PROJECT_LAYER` ile durdurur; teslim commit'inin yazarı hiçbir ayarda referans olamaz
  (`SECRET_REFERENCE_LEAVES_HOST`). *Etki:* alpha.48'den önce `$DECK:` kullanan bir proje dosyası değiştirilene kadar yüklenmez.
  *Yol:* referansı kurulum ayarına taşıyın ya da düz değeri yazın.
- **Sır kapısı Git geçmişini taramaz.** İş gönderilmeden önce işçinin aldığı her şeyi (çalışma kopyası, `.git` üst verisi,
  bağlamalar, görev girdileri, istem bağlamı) tarar ve bulursa reddeder; nesne deposundaki eski commit'ler taranmaz. Hariç
  tutmalar yalnız ayarda yazılı yollar ya da bildirilmiş bir bağımlılık ağacıdır, denetime yazılır ve Run kartında görünür.
  *Yol:* geçmişe girmiş sırları geçmişten çıkarın ve değiştirin; isteğe, istem metnine ya da `DECKENT.md`'ye asla kimlik
  bilgisi koymayın.
- **Bildirilmiş bir bağımlılık ağacına içerik kalıpları için güvenilir.** Görev profilinin `dependencyTree` olarak bildirdiği,
  gerçek yolu iş denemesinin çalışma alanı ve iş hedefi (work target) kopyasının dışında kalan salt okunur bir bağlama (örneğin
  `node_modules`) üçüncü taraf içeriktir (ayrı bir iş hedefi yoksa proje kökü o kopyadır; içindeki bağlama normal kurallarla
  taranır): içindeki kimlik bilgisine benzeyen metin (test
  verileri, tip tanımları, README'ler) reddedilmez, denetime yazılan istisna olarak geçer; `execution.secretGate.maxFileBytes`
  üstündeki yerel ikili dosya sınırlı pencerelerle okunur ve SHA-256 özetiyle listelenir. Başlığı yerel ikili olduğunu söyleyen
  bir dosyada özel anahtarlar ve sağlayıcı/bulut anahtarları reddedilir. Yasak listedeki dosyalar (`.npmrc`, `.env`,
  anahtarlar) ve yapılandırılmış sır değerleri orada da reddedilir; arşivler ve sınırı aşan başka her dosya yine taranamaz
  sayılır; büyük ikili dosyalar yalnız 1 MiB'lik pencerelerle okunur, pencereler arası taşıması (carry) sınırlanamayan
  (1 MiB'yi aşan) ya da gövdesinin herhangi bir yerinde arşiv taşıyan (sona eklenmiş zip, gömülü gzip) dosya taranamaz sayılır.
  Arşiv tespiti her biçimin en hoşgörülü yaygın açıcısını izler (gövdenin herhangi bir yerindeki zip bitiş kaydı, yazılı ofsetlerine bakılmadan;
  ayrılmış bayrak bitli gzip; işaretli tar sağlama toplamı), ama kapsayıcı başlığı olmayan sıkıştırılmış ya da kodlanmış veri (ham
  deflate, zlib, brotli, LZMA-alone, lz4, özel bir kodlama) makine kodundan ayırt edilemez: ikili dosyanın özet istisnası içinde geçer
  ve işçi onu bilinen bir ofsetten açabilir (örneğin Node'un kendi zlib'iyle). `maxFileBytes` sınırında ya da altındaki yerel ikili dosya bütün okunur ve arşiv yalnız dosyanın başında tanınır; böyle bir dosyanın ilerisine gömülü arşiv geçer (kapatmak esbuild gibi yaygın bağımlılık dosyalarını reddettirir; beta sürecinde her ofsetin taranmasına ve kilit dosyasına sabitlenmiş özet istisnalarına geçilir). Kalıp
  sonuçları dosya içeriğine göre ürünün `state/tree-scan-cache` alanında saklanır; değişen kilit dosyası (lockfile) ya da
  sürüm baştan başlatır, imzasız önbellek yalnız hangi istisnaların listelendiğini değiştirebilir, hiçbir kararı değiştiremez.
  Ağaç ana makinede taranır ve canlı, salt okunur bağlanır: taramadan sonra ana
  makinede yapılan bir değişiklik işçiye taranmadan ulaşır (her bağlamada olduğu gibi).
  *Etki:* bir bağımlılık paketine düz metin olarak konmuş gerçek bir anahtar işçiye ulaşır, yalnız istisna olarak görünür.
  *Yol:* yalnız güvendiğiniz bir kilit dosyasından kurulan ağaçları bildirin ve Run kartındaki istisnaları gözden geçirin.
- **Eşzamanlı işler aynı bağımlılık ağacının tek sır taramasını yalnız tek bir süreç içinde paylaşır.** Çalışma servisi aynı anda
  `execution.secretGate.maxConcurrentScans` taramaya izin verir; bildirilmiş bağımlılık bağlaması aynı kaynak, hedef, kilit dosyası
  baytları ve ayarlara sahip işler sürmekte olan taramayı bekler. Ayrı bir CLI `execute` süreci kendi taramasını yapar, okunabilir kilit
  dosyası olmayan bir bağlama hiç paylaşılmaz ve süren bir taramaya katılan iş, o taramanın kendisi gelmeden önce okuduğu dosyalara
  güvenir (taramadan sonraki her değişiklikle aynı pencere). Sınırlar artık işin kendi görünümlerine ve paylaşılan bağlamalara ayrı ayrı
  uygulanır. Yük altında süresi dolan tarama, deneme reddedilmeden önce deneme başına en fazla `maxTimeRefusals` kez yinelenir.
  *Yol:* büyük ağaçlar için `maxConcurrentScans` ya da `timeoutMs` değerini yükseltin; paralel CLI çalıştırmaları yerine servisi kullanın.
- **Sır kapısının ayar kuralı yalnız ayar türü dosyalara bakar.** Sıradan kaynak koduna yazılmış bir parola yakalanmaz.
  *Yol:* sırları bir sır deposunda tutun, kaynak kodda değil.

- **Yetki değişikliği terminaldeki bir kişiyi gerektirir.** İzin modunu değiştirmek, bir secret'ı yazmak ya da silmek veya
  secret deposunu değiştirmek, isteği yapan sürecin girişi ve çıkışı etkileşimli bir terminalde değilse
  `AUTHORITY_WITNESS_REQUIRED` ile reddedilir; MCP aktörü her zaman reddedilir ve hiçbir şey karara bağlanmaz, denetime
  yazılmaz ya da değişmez. *Etki:* `echo ANAHTAR | deckent secret set AD`, betikler, bir betikten çağrılan SDK ve yapay zekâ
  araçları bu değişiklikleri artık yapamaz; bunlar için henüz bir onay isteği yolu yok. *Geçici çözüm:* `deckent secret set AD --main`
  (ya da `--project`; gizli istem), `deckent secret store` ya da terminalin `/provider` ve mod değiştirmesini etkileşimli bir terminalde kullanın.
- **Runtime soketi sandbox'taki süreçleri reddeder, hesabınızın diğer süreçlerini değil.** Runtime servisi kendi PID, mount ve
  user namespace'i dışındaki bir eşi reddeder, tam erişimli bubblewrap görünümü runtime soket dizinlerini gizler ve Landlock
  realm'i hiç unix soketi açamaz. Hesabınızın sandbox dışında çalıştırdığı bir süreç (tam erişimli bir turda onaylanan host
  realm çağrısı, host'ta çalışan bir MCP sunucusu, başka bir ajan) sokete yine ulaşır ve yukarıdaki yetki değişiklikleri
  dışında her şeyi sizin adınıza yapar. *Geçici çözüm:* güvenilmeyen sunucuları ve ajanları bir sandbox'ta ya da ayrı bir
  hesapta çalıştırın.
- **Kendi işletim sistemi hesabınızla çalışan bir yapay zekâ ajanı Deckent onaylarıyla sınırlanmaz.** Onay ve denetim
  kayıtları hesabınızda duran bir anahtarla mühürlenir, etkileşimli terminal denetimi bir insanı değil bir terminali
  kanıtlar ve policy dosyasını hesabınız yazabilir. Hesabınız Docker ya da sudo kullanabiliyorsa böyle bir ajan pratikte
  her şeyi yapabilir. *Etkisi:* onaylar ve policy Deckent'in kendi kum havuzundaki işçilerine karşı korur, sizin adınıza
  çalıştırdığınız başka ajanlara karşı korumaz. Denetim kontrol noktaları (`deckent audit verify`) değişen policy'yi ya da
  üretici kümesini ve kesilen ya da silinen denetim kaydını gösterir; iki yerel geçmişin kendi hesabınızda birlikte geri
  alınmasını yalnız ayrı bir cihazda saklanan kontrol noktası dışa aktarımı yakalar. Ayrı bir onay kanalı, sabit bir denetim tabanı ve uzak karar tasarımı beta sürecinde ele alınır; donanım anahtarıyla
  imzalı policy ve onaylar beta sonrası gelir.
  *Çözüm:* başka yapay zekâ ajanlarını Docker ya da sudo yetkisi olmayan ayrı bir hesapta çalıştırın, Deckent işçilerini
  kum havuzunda tutun.
- **Tam otomatik ya da tam erişimi açmak kişinin kendi terminalindeki eylemidir.** `deckent init policy --scope <id> --modes <liste>|none`
  kurulum sahibi için kipleri açar ya da kapatır; yapay zekâ araçları, borular ve CI yapamaz. Uygulamadan sonra policy yeni bir `a-…`
  revizyonu alır; bu yüzden `deckent doctor` artık ona `first-run-template-v13` demez ve sonraki `init policy --upgrade` yalnız ekleyen
  yolu izler. Terminal tanığı kontrol eden terminaldir: aynı UID'li bir süreç sahte pty üretebilir (SEC-1 sınırı; bir Enterprise
  bileşimi daha güçlü tanık verebilir); yapay zekâ ajanının kabuğunu yalnız tanık değil, ajan işareti ve CLI kart kapısı reddeder.
  Bir kipi kapatmak kişinin kayıtlı tam otomatik seçimini bağlarda tutar ama geçerli kılmaz: her çağrı izni yeniden denetler.

## Sağlayıcılar ve abonelikler

- **Claude aboneliği:** Claude Code işçisi kendi Claude girişinizle çalışır. Abonelikli Brain (`/do`'nun arkasındaki planlayıcı)
  hazırlanıyor ve henüz yok. Claude aboneliğiyle terminal sohbeti şu an desteklenmiyor. *Yol:* terminal sohbeti ve `/do`
  planlaması için bir Anthropic API anahtarı kullanın.
- **Terminal sohbeti bir model bağlantısı ve ücretli API için bütçe ister.** İlk oturum yalnız abonelikle sohbet edemez; kapsam
  bütçesi olmadan ücretli API turu reddedilir. *Yol:* `/provider` ile API anahtarı bağlayın, bütçe koyun, `/model` seçin.
- **Bugün işçi, girişinizi CLI'ın kendi kimlik dosyasını ev dizininizden okuyarak alır.** *Etki:* o dosya var olmalı ve
  Deckent tarafından okunabilmelidir. Bu yol değişebilir.
- **Abonelikli işçi, çalıştığı sürece giriş token'ınızın kısa ömürlü bir kopyasını tutar.** Deckent işçinin konteynerine
  yalnız geçerli erişim token'ını (Codex'te kimlik token'ını da) kopyalar ve süresinin dolmadığını denetler; yenileme
  token'ları, API anahtarları ve giriş dosyasının geri kalanı makinede kalır. *Etki:* işçinin CLI'ı, o token'ın süresi
  dolana kadar abonelik hesabınız adına işlem yapabilir. *Yol:* yok; sınır, token'ın kendi süresidir.
- **ChatGPT ile giriş henüz yok.** `/provider` bunu kullanılamıyor olarak listeler; görünür giriş beta sürecinde ele alınır. *Yol:* bir OpenAI API anahtarı ya da kendi
  girişiyle bir Codex işçisi.
- **Aboneliklerden API modeline henüz otomatik geçiş yok.** Bir abonelik penceresi tükendiğinde Deckent kendiliğinden ücretli
  bir API'ye geçmez; bildirilen aday listesi üzerinden yönlendirme planlı. *Yol:* bir API modelini kendiniz bağlayın ve seçin.
- **Doğrulanmış yayımlanmış fiyatı olmayan uzak model kilitlidir.** Zhipu GLM Çin, fiyatları CNY olduğu için kilitli kalır.
  DeepSeek yayımlanmış tepe fiyattan kesinleşir ve üst sınır olarak etiketlenir. *Yol:* fiyatı olan ya da yerel bir model kullanın.
- **Başka bir makinedeki model sunucusu henüz bağlanamaz.** Düz `http` yalnız bu makinede (`127.0.0.1` ya da `[::1]`) kabul
  edilir; uzak bir OpenAI uyumlu sunucu yayımlanmış bir fiyat satırı ister. Bugün bu satırlar yalnız OpenAI, DeepSeek ve Z.ai
  API'leri için var ve kendi fiyatınızı bildirmenin yolu yok. *Etki:* ağınızdaki bir şirket model sunucusu kullanılamaz.
  *Yol:* model sunucusunu bu makinede çalıştırın.
- **Codex ya da Cursor işçisinin kullandığı model doğrulanamaz.** Model başına kullanımı yalnız Claude Code bildirir; Codex ve
  Cursor sonuçları doğrulanmamış olarak kaydedilir ve ölçütlerine göre kabul edilir. *Etki:* böyle bir işçi başka bir modelle
  çalıştıysa iş yine kabul edilir.
- **Codex ve Cursor işçileri çalışmaları hakkında az şey bildirir.** Codex denemesi tek tur ve token kullanımı yok gösterir; Cursor
  denemesi tur, token ya da maliyet göstermez. *Etki:* emek ve maliyetleri Claude Code ile karşılaştırılamaz. *Yol:* teslim edilen
  sonuca göre değerlendirin.
- **Cursor için paketli işçi model kataloğu yok.** İşçi yalnız etkin bir `native-cli` katalog kanalıyla kabul edilir; Claude Code
  ve Codex'in paketli katalogları var, Cursor'ın yok. *Yol:* bir katalog yazıp `deckent models catalog register --file` ile
  kaydedin.
- **Deckent sağlayıcı tarafındaki ayarları göremez.** OpenRouter için "Prevent overrides" eklenti ayarını ya da OpenRouter kredi
  sınırınızı göremez. *Yol:* ilk ücretli çağrıdan önce ikisine de kendiniz bakın.
- **alpha.48'den önceki MCP güveni bir kez yeniden sorulur.** Proje ve yerel MCP sunucularının güveni proje klasöründen
  Deckent genel köküne taşındı; bir depo artık güveni kendisiyle getiremez. alpha.48'den önce güvenilen bir sunucu kartını
  bekler (`mcp list` nedeni `trust-moved`); `deckent mcp approve <ad> --yes` onu `MCP_TRUST_NEEDS_CARD` ile reddeder. Veri
  klasöründeki eski `integrations/mcp-trust.json` yerinde kalır ve güven olarak hiç okunmaz. *Yol:* terminalde ilk kullanımda
  kartı yanıtlayın ya da bir terminalde `deckent mcp approve <ad>` çalıştırın; sonra isterseniz eski dosyayı silin.
- **Proje MCP dosyası yalnız birkaç ortam değişkeni okur.** Proje `.deckent/mcp.json` içindeki `${VAR}` yalnız `HOME`, `USER`,
  `LOGNAME`, `LANG`, `LC_ALL`, `TZ` ve `TMPDIR` okur; başka bir ad yazılı varsayılanını ya da boş okur, kimlik bilgisi taşıyan
  bir değer sunucuyu reddettirir. Bilinen kurulum sırlarıyla karşılaştırma henüz yok (yalnız kimlik bilgisi kalıpları).
  *Yol:* başka değişken isteyen bir sunucuyu yerel ya da kullanıcı kapsamına koyun (`deckent mcp add`).
- **Proje MCP güveni proje dışında bir genel kök ister.** `DECKENT_GLOBAL_HOME` (yoksa `DECKENT_HOME`) projenin içini
  gösterirse proje ve yerel sunucular `trust-store-unavailable` gösterir ve hiç başlamaz. *Yol:* `DECKENT_GLOBAL_HOME`'u
  projenin dışına yöneltin.
- **Bir MCP sunucusuna güvenmek terminaldeki bir kişiyi ister.** `deckent mcp approve` ve yerel ya da kullanıcı kapsamına
  `deckent mcp add` kartını yalnız gerçek bir terminalde gösterir; pipe, CI ya da bir yapay zekâ aracından reddedilir
  (`MCP_APPROVAL_NEEDS_TERMINAL`) ve `--yes` artık kartı atlamaz. *Yol:* betikten sunucuyu `--no-approve` ile ekleyin; ilk kullanımda sorar.
- **`deckent mcp import` seçilen istemcinin bütün sunucularını alır.** Terminalde istemciyi seçersiniz; tek tek sunucu seçimi
  henüz yok. İçe aktarılanlar güvenilmeden kalır. *Yol:* içe aktarmadan sonra `deckent mcp remove <ad>`.
- **OAuth ile MCP sunucuları desteklenmiyor.** Streamable HTTP sunucuları OAuth olmadan çalışır. *Yol:* yerel bir stdio sunucusu ya da
  OAuth gerektirmeyen bir HTTP sunucusu kullanın.
- **Sağlayıcı anahtarları ana kasada (kurulum) ya da proje kasasındadır; ana kasa anahtarı bir projede yalnız izinle kullanılır.**
  Terminal dışı `deckent secret set` için `--main` ya da `--project` gerekir; proje anahtarları `.deck` dosyası ister (yalnız
  referans); ana kasa anahtarı proje başına izin ister (solo terminalde kart ya da `deckent secret grant AD --scope S`). *Sınırlar:*
  alpha.50'ye dönüşte izin tabanı kalkar (eski sürüm ana kasa anahtarlarını eskisi gibi kullanır, proje kasasını görmez). Native
  macOS'ta ve Windows'ta terminal tanığı yok: ilk kullanım kartı çıkmaz, `secret grant` orada reddedilir (Linux terminali ya da yönetici
  izin verir). İlk kullanım anahtar kartı yalnız Linux'ta, solo kurulumda, kişinin kendi terminalindeki akışlı sohbette görünür. Ajan
  turları bunun dışına çıkamaz: tam erişimli bir ajan turu yalnız gerçek açık sandbox'ta çalışır (host alanı orada reddedilir) ve kasalar
  oradan erişilemez; ajanın kendi yetki komutları her modda kişinin kartını sorar (bir yorumlayıcının satır içi programı metni ürünü
  adlandırdığında sayılır; karakter kodlarından ya da kodlamalardan kurulan program metni tanınmaz — sınır açık sandbox ve kasa
  tabanıdır). Kalan sınır ajan turlarının dışındadır: kişinin kendi
  hesabında terminali olan aynı kullanıcılı her süreç (`script` gibi bir pty sarmalayıcısı dahil) `approval decide` ile aynı terminal
  tanığını geçer. Çıplak (bare) bir deponun worktree'leri ayrı proje kasası alır (paylaşılacak ana çalışma ağacı yok). `.deck` ajan araçlarına kapalıdır ama işçiyi durdurmaz.
- **Adında secret, token ya da password geçen ve değeri düz metin gibi görünen müşteri yapılandırma anahtarı yine reddedilir**; değer
  bir sır AD referansı olsa bile (örneğin `"secretName": "DB_PASS"`). *Yol:* anahtarı yeniden adlandırın ya da yolu onaylayın.

## Bütçe ve harcama

- **Tüm bir Run için harcama tavanı yok.** Her ücretli model çağrısı kapsamın USD bütçesinden en pahalı geçerli fiyatla pay
  ayırır, ama uzun süren bir API işçisinin harcayabileceği toplamın sınırı yoktur. *Etki:* API işçisindeki bir Run kapsam
  bütçesini tüketebilir. *Yol:* küçük bir kapsam bütçesi ve sağlayıcınızda bir kredi sınırı belirleyin.
- **Abonelik ve yerel modeller USD bütçesiyle ölçülmez.** Bir abonelik ya da yerel model bütçe olmadan çalışmaya devam eder.
  *Etki:* sınırları Deckent'in değil, sağlayıcı planınızın sınırlarıdır.
- **Sağlayıcı başına harcama sınırı yapılmadı.** Kapsam başına tek ortak USD bütçesi var. *Yol:* sınırları her sağlayıcı
  hesabında belirleyin.
- **Kesinleşen harcama Deckent'in kendi hesabıdır:** sağlayıcının bildirdiği kullanım çarpı doğrulanmış fiyat (OpenRouter
  çağrıları OpenRouter'ın bildirdiği ücretten kesinleşir). Sağlayıcının faturası değildir.
- **Son kullanımı hiç bildirilmeyen çağrı tutulu kalır;** `deckent models reconcile-spending` ile çözene kadar.

## Teslim ve dala alma

- **Bir iş görevi geçerli bir sonuç raporu ister, ama raporu olmayan bir işçi CLI'ı denetlenmez.** 1.0.0-alpha.47'den beri 0 ile
  çıkan ve geçerli rapor bırakmayan bir iş görevi `report-missing` ya da `report-invalid` ile başarısız olur. Yapılandırılmış sonuç
  kanalı olmayan (bugün Cursor) ya da kurulu sürümü bunu artık sunmayan bir CLI `unsupported` okunur ve bu kapıdan geçmez. 1.0.0-alpha.50'den
  beri işçi rapor kontrolünü `checkId` ve `role: acceptance` ile işaretleyebilir ve işçi talimatı bunu ister; son sonucu `passed`
  olmayan kabul kontrolü görevi reddeder (`declared-check-not-passed`). Kontrollerini tiplemeyen işçi yakalanmaz: tipsiz ve keşif
  amaçlı kontroller iddia olarak kalır ve kabulü engellemez. *Geçici çözüm:* tamamlanması kanıtlanması gereken işlerde Claude ya da
  Codex işçilerini tercih edin.
- **Bir kodlama görevi çıkış koduyla kabul edilir.** Ölçütü daha fazlasını isteyebilir (saklanan fark, geri okuma), ama kodlama
  görevlerinin kullanabildiği tek değerlendirici `process-exit`'tir ve hiçbir Core iş sınıfı kabul profili bağlamaz; bu yüzden ek kanıt
  denetlenmez. 1.0.0-alpha.50'den beri değerlendirme satırı bunu söyler ("kabul · çıkış kodu · içerik bağımsız doğrulanmadı"):
  monitör, `workers`, `/runs`, `run inspect`, `task inspect` ve `report`; "1/1 kabul" gibi sayılar nitelenmez. Gerçek doğrulama
  değerlendiricisi olan kabul profili beta işidir.
- **Deckent yalnız görevin bildirdiği ortam gereksinimlerini denetler** (1.0.0-alpha.50'den beri). Bir görev profili ya da şablonu
  `environment.requirements` bildirebilir; Deckent bunları işçi başlamadan denetler, biri karşılanmazsa Run'ı "ortam hazır değil: <id>"
  diye park eder (işçi ve model çağrısı yok; düzeltip devam ettirince yeniden denetler). Bildirilmemiş eksik bir araç, çalıştırılamayan
  kontrol (`acceptance-check-not-run`) olarak raporlanır; bu işçinin iddiasıdır, ortam kusurunun kanıtı değildir. Gereksinimler Run ile
  dondurulur; kayda eklenen gereksinim `deckent runtime restart` sonrası yeni Run'larda geçerlidir. Core kodlama denetim türlerini
  (executable, path-readable, node-heap) getirir; bağlayıcı ya da kimlik bilgisi türleri Enterprise/ERP paketlerinden
  `deckent/extensions` ile gelir, kimsenin kaydetmediği tür başlatmayı reddeder. Her denetim kısa bir kap başlatır ve yanıt vermeden önce
  kabın silindiğini kanıtlar (referans makinede yaklaşık 0,85 sn); silindiği kanıtlanamazsa Run belirsiz olarak park edilir (deneme kodu
  `EXECUTION_ENVIRONMENT_UNCERTAIN`; monitör ve `run inspect` bunu diğer ortam parkları gibi gösterir) ve sonraki hizmet açılışı bu
  kurulumun artakalan denetim kaplarını kaldırır. Bir denetimin silindiği kanıtlanmadıkça Run'ı havuz yerini tutar, kapatılamaz ve
  devam ettirilemez (`RUN_DECISION_NOT_READY`); iptal ve park süresi bu yeri açmaz. Silindiği hiç kanıtlanamayan denetim yeri süresiz
  tutar; hizmet günlüğü her açılışta onu adlandırır ve `docker rm --force <ad>` sonrası bir sonraki hizmet açılışı yeri bir kez açar
  (o Run'ın ilerleme turu bunu yalnız böyle bir tur koştuğunda yapar; olağan ilerleme ortam yüzünden park edilmiş ya da iptal edilmiş
  Run'ları atlar). Bir denetimin kaldırıldığı doğrulanır ama yerini açan defter yazımı başarısız olursa, açılış günlüğü bunu hata koduyla söyler ("kaldırıldığı doğrulanamadı" demez); yer bir sonraki açılışa kadar tutulur. Yer, ilk denetim kabı başlamadan önce tutulur: denetim sürerken Run'ı iptal etmek denetim bitene kadar hiçbir şeyi
  açmaz; hizmet denetimin ortasında ölürse yer, bir sonraki hizmet açılışı denetimlerin kaldırıldığını kanıtlayana kadar tutulur. `deckent coding template` varsayılanları bildirir (node, Node heap tavanı; typescript yolu yalnız `/node_modules`
  bağımlılık bağlaması olan şablonda); mevcut görev türü şablonunu korur (komutu o tür için yeniden çalıştırmak
  `CODING_TEMPLATE_KIND_CONFLICT` ile reddedilir), bu yüzden ona bugün gereksinim eklemek `deckent config set` ile `admission.registry`
  düzenlemek demektir. doctor ortam yüzünden park edilen Run'ları henüz listelemez; `monitor` ve `run inspect` gösterir.
- **Sessiz bir işçi durdurulur ve bir kez yeniden denenir, ama yalnız bazı görevler izlenir.** 1.0.0-alpha.47'den beri sessizlik sınırı
  boyunca (varsayılan 1 saat, `runRuntime.stallRecovery.stopAfterMs`; 3 dakikada uyarı) hiçbir olay ve model trafiği göndermeyen bir
  native abonelik işçisi durdurulur. Etkileri yalnız kendi çalışma alanında kalan bir görev yeni bir Attempt ile bir kez yeniden
  denenir; diğer görevler eskisi gibi insan kararını bekler. Sınır yalnız profilin süre sınırından (deadline) önce durdurabiliyorsa
  uygulanır: profil süre sınırı bu sınırdan kısa olan bir görev (1 saatlik varsayılanla bir saatin altındaki her süre sınırı)
  izlenmez, sessizlik uyarısı almaz ve yalnız süre sınırıyla sınırlanır. alpha.47'den önce oluşturulan Run'lar ve native gateway'i
  olmayan işçiler de yalnız süre sınırıyla sınırlanır. Sessiz bir işçi durdurulana kadar yürütme yuvasını tutar; takılmış bir işçi bir
  yuvayı sınır süresi boyunca tutabilir. İzlemedeki `worker-silent` uyarısı işçi olaylarını görür, model trafiğini görmez; bu yüzden
  işçi hâlâ çalışırken uyarabilir. İşçinin içindeki tek bir uzun araç çağrısı (build, test koşusu ya da kilit beklemesi) sürdüğü
  boyunca olay ve model trafiği göndermez, bu yüzden sessizlik sayılır: sınırdan uzun bir çağrı durdurulur, tekrarı görevi
  `worker-stalled` ile başarısız kılar. Durdurulan Attempt'in çalışma alanı kopyası tutulur. *Geçici çözüm:*
  `runRuntime.stallRecovery.stopAfterMs` değerini (ya da iş sınıfının `inactivity` değerini) en uzun araç çağrınızın üstünde tutun;
  süre sınırı önce geliyorsa ve sessiz işçilerin daha erken durdurulmasını istiyorsanız bu değeri düşürün ya da profilin süre
  sınırını artırın.
- **Hedef kuyruğu canlıda kullanılıyor ama beta için henüz kabul edilmedi.** 1.0.0-alpha.43'ten beri canlıda çalışıyor ve gerçek teslimleri sonuçlandırdı. Kayıtlı Git hedefi, özel birleşik aday doğrulaması, ayrı
  yayın/benimseme parti kartları ve ayrı onaylı geri alma bağlandı. Runtime protocol v29 ve ledger v58 yeniden build edilmiş
  binary ve switch öncesi doğrulanmış ledger yedeği gerektirir. Gerçek terminal/socket/crash ve N1 yük kabulü ayrı kapılardır;
  ölçülmüş kapasite iddiası yoktur. Konum yalnız yetkili kapsamı sayar; görünüm son bilinen durumdur. Teslim penceresi şu an
  açıkça yenileme gerektirir.
- **Kuyruk doğrulaması kurulu profil ve normal Run yetkisi ister.** Özgün evaluator kriterleri ve güncel benimseme bar'ı
  birlikte aranır. Desteklenmeyen profil/değişmiş evaluator reddedilir; Run-create onayı bileti bekletebilir. Normal onayı
  cevapladıktan sonra aynı enqueue komutunu yineleyin; politika atlanmaz. Belirsiz etki uzlaştırmada kalır; TTL'nin geçmesi
  eski sürecin bittiğini kanıtlamaz.
- **Kuyruk generation'ı doğrudan eski yazıcıyı durdurur.** Etkinleşme, bir hedefteki ilk onaylı kuyruk yürütmesidir; sıraya alma,
  hazırlık, doğrulama, çakışma ve reddedilen ya da süresi dolan kart hedefe hiçbir şey yazmaz. Etkinleşmeden önceki doğrudan
  yazım yalnız bekleyen bileti eskitir (tipli ret). Etkinleştikten sonra geri alma dahil kuyruk komutlarını kullanın:
  `integration-queue-rollback` ve `integration-queue-confirm`. Meşgul hedef geri almayı reddeder. Aşağıdaki doğrudan yol
  sınırları kuyruğu aşma yolu değildir. Uzak hosting koruması sorgulanmaz; kayıtlı politika ve yerel depo/remote-HEAD bilgisi
  kullanılır.


- **Teslim ve dala alma yalnız Git içindir.** Bir çalışma hedefi tek bir Git deposudur (tam bir tane desteklenir). *Etki:* bir
  iş sistemindeki iş için teslim yüzeyi yoktur; sonuçları yama gibi teslim edilmez.
- **Checkout edilmiş bir dala dala alma yapılamaz.** Dala alma yalnız hiçbir çalışma ağacının kullanmadığı bir dalı ilerletir;
  üzerinde çalıştığınız dal (çoğu zaman `main`) reddedilir. *Yol:* ayrı bir dal açın (`git branch deckent/first-job HEAD`),
  onu `execution.adoption.targets` içine yazın ve birleştirmeyi kendiniz yapın.
- **Aynı dala bayat hazırlanmış doğrudan teslim reddedilir,** dal hâlâ teslim tabanında değilse (`ADOPTION_BASE_CHANGED`). Deckent sizin için
  rebase ya da merge yapmaz. *Yol:* güncel tabanda yeniden teslim edin.
- **Bayat bir checkout'ta üretilen yama uygulanmayabilir.** Teslim kontrolü, bir şey yazılmadan önce durdurur.
  *Yol:* isteği güncel kaynakla yeniden çalıştırın.
- **Terminalde geri alma penceresi yok.** Dala almayı geri almak bir komut satırı adımıdır; terminal dala almanın komut
  kimliğini ve `deckent task integration-rollback --adoption-command-id` ipucunu gösterir. *Yol:* o komutu çalıştırın ya da
  dalı `Benimsendi:` satırındaki commit ile Git'te kendiniz geri taşıyın.
- **Teslimden sonra terminal penceresi o görev için yeniden açılmaz;** bazı mesajlar `/deliver`'ın yeniden açtığını söylese de.
  *Yol:* önceki maddedeki gibi komut satırından dala alın.
- **Dala alma penceresi doğrulama Run'larını commit'e göre önceden süzemez.** Yapılandırılmış türdeki kabul edilmiş
  doğrulama Run'larını listeler; başka bir commit'i doğrulamış olan dala almada reddedilir ve pencere seçime döner.
- **Doğrulama Run'ı terminalden oluşturulamaz.** *Yol:* pencerenin gösterdiği `deckent run create ... --delivery-command-id
  <kimlik>` komutunu başka bir kabukta çalıştırın, sonra pencerede `r`'ye basın.
- **Varsayılan olarak dala alma, doğrulamaya değil kayıtlı kabule dayanır.** `Benimsendi:` satırı bunu söyler.
  *Yol:* doğrulama Run'ı zorunlu olsun diye `execution.adoption.verification` ayarlayın.
- **Run oluşturma onay kartı her satırı doldurmaz.** Risk ve Geri alma satırları aracın bunları sınıflandırmadığını ya da
  bildirmediğini söyler. *Yol:* planı ve kabul ölçütünü okuyun; Run oluşturmayı onaylamak sonucunu kabul etmek değildir.
- **Komut satırındaki `deckent do` siz onaylayınca devam etmez.** Öneriyi planlar ve kaydeder; karardan sonra aynı komutu aynı
  `--command-id` ile yinelersiniz; kimlik basılmaz, bu yüzden `--command-id` ile kendinizinkini verin. Terminalde `/do` kendiliğinden
  devam eder.
- **Soru soran bir işçiye terminalden cevap verme henüz yapılmadı.** *Yol:* `deckent run resume --scope <id> --id <run>
  --command-id <id> --expected-revision <n> --task <id> --answer <metin>`.
- **Otonom teslim tasarlandı ama kapalı.** Her teslim ve dala alma, doğrulanmış bir terminalde sizin `y`'nizi ister.

## ERP ve operasyonlar

- **ERP bağlayıcısı yok.** Operasyon sözleşmesi (niyet, koşullu yazım, tekrarsız yeniden gönderim, kanıtla kabul, telafi) ve
  uzantı girişi var; IFS, SAP, Oracle, Microsoft, Uyumsoft ya da Logo adaptörleri yok. Çalışan tek örnek hedef bir test
  fixture'ıdır. Core ayrıca genel bir `http-conditional` REST hedefi sunar (ETag, `If-Match`, `Idempotency-Key`; operasyonları
  ayarda tanımlanır); kimlik bilgisi göndermez. *Etki:* kimlik doğrulama isteyen ERP'ler dahil, ERP etkilerini çalıştırmak
  için kendi adaptörünüzü yazmalısınız.
- **`deckent operation list` yok.** Tek bir operasyona `deckent operation inspect --scope <id> --command-id <id>` ile
  bakabilirsiniz, yani kullandığınız komut kimliklerini saklamalısınız. *Etki:* bekleyen ve belirsiz etkiler listelenemez.
  (Tek başına `deckent operation` yapılandırılmış işlem kataloğunu listeler, çalışmış komutları değil.)
- **`deckent operation execute` terminalde de komutu JSON olarak alır.** Adım adım akış henüz yok (katalogdan işlem → hedef →
  şemadan parametreler → önizleme → onay → aynı ekranda bekleme); `--schema` sözleşmeyi basar ve hatalı belge alanını adıyla
  söyler. *Etki:* kişi komut belgesini elle ya da bir betikle yazar.
- **Belirsiz bir ERP yazımından yeniden göndermeden başka çıkış yok.** Hedef yazımın olup olmadığını söyleyemiyorsa Deckent onu
  kendiliğinden yeniden denemez ve kayıt hedefi meşgul tutar. Hedef sonradan doğrulayabiliyorsa aynı komut kimliğini yeniden
  gönderin, kanıtı kaydı kesinleştirir; doğrulayamıyorsa kayıt çözümsüz kalır. *Etki:* bir kişi onu henüz kapatamaz.
  İnsan beyanıyla (kanıt eki zorunlu, kabul sayılmaz) kapatma planlı.
- **Bir operasyonun onay kartı operasyonu, hedefi ve 12 karakterlik girdi özetini gösterir,** yazacağı alanları değil.
  *Etki:* onaylayan tutarı ya da durumu göremez. *Yol:* onaylamadan önce girdi dosyasını inceleyin.
- **Bir ERP sonucunun kabul edilmemesinin on yedi nedeninden onunun okunabilir metni yok** (altısı kanıtla, dördü telafiyle
  ilgili); kodu görürsünüz.
- **Okuma operasyonu yalnız kayıt sürümünü döndürür,** iş verisini değil.
- **Her operasyon elle yazılmış bir JSON komutudur;** kendi komut kimliği, idempotency anahtarı ve beklenen sürümü vardır;
  operasyon kataloğu ve hedef yapılandırması kullanıcı belgelerinde anlatılmıyor.
- **ERP etki sonuçları henüz denetim izine kendi olayları olarak yazılmıyor.** Yetki ve policy değişiklikleri denetlenir;
  genel etki yolu sonucunu ledger'a yazar.
- **Enterprise SSO, filo yönetimi ve merkezi policy hizmeti yok.** Policy modülünün kalan parçaları (kartlı kurucu admin
  kurtarma, iki kişiyle devir, rol düzenleme, imzalı paketler) yapılmadı.
- **`deckent policy grants --all` başlangıç zamanını yalnız yönetilen kalıcı onaylar için gösterir.** "Başlangıç" sütunu kuralı
  oluşturan mühürlü denetim değişikliğinden gelir; elle yazılmış ya da denetimden eski bir kural "—" gösterir ve bir kapsamın
  yalnız ilk 10 000 politika değişikliği aranır (sayfa o zaman zamanların eksik olduğunu söyler). Kişiler issuer/subject olarak
  görünür: Core görünen ad tutmaz.

## Kurtarma ve yükseltme

- **`cancelled` (iptal) görünen bir adımın etkisi uygulanmış olabilir** (owner 2026-10-21: düzeltme betada planlandı). Onaylanan
  bir araç çağrısı bittikten sonra tur iptal edilirse (bağlantı kopması, açık iptal, kapanış) çağrı yine `cancelled` bildirilir;
  iptalle durdurulan bir yazma kümesi kısmen uygulanmış kalabilir. Sonuç metni yazılanları listeler. *Yol:* iptal görünen bir
  adımı yeniden çalıştırmadan önce sonuç metnine ve hedeflediği dosya/kayıtlara bakın; hiçbir şey olmadığını varsaymayın.
- **Yedek kümeleri tamamen şifreli değildir.** Kümenin içindeki yalnız yetki anahtarı parolanızla şifrelenir; ledger ve durum
  arşivi düz dosyadır. *Yol:* kümeleri şifreli depolamada saklayın, parolayı ayrı tutun.
- **Geri yükleme yedek zamanlamasını kapatır** ve sağlayıcı anahtarları ile yedek parolası kümede değildir. *Yol:* geri
  yüklemeden sonra `backup.schedule`'ı yeniden seçin ve her anahtar için `deckent secret set` çalıştırın.
- **Geri yükleme servisin durmuş olmasını ister** ve mesaj komutu söylemez. *Yol:* `deckent runtime shutdown` (terminalde kartla
  sorar; başka yerde `--reason <metin>` ekleyin; `--service`, `--instance`, `--command-id` ve `--reason` içeren uzun biçim de
  çalışır), açık terminalleri kapatın, sonra geri yüklemeyi yeniden çalıştırın. Terminalde `deckent backup restore` bunu parolayı
  sormadan önce denetler.
- **`deckent backup` yalnız varsayılan kurtarma klasörünü listeler** (`state/backups/recovery`); `--set` ile başka yerde oluşturulan
  setler görünmez. "Son doğrulama" yalnız bu kurulumun mühürlü yedek audit kayıtlarından, aynı mutlak set yolu için gelir; yolu başka
  yazımla doğrulanan bir set "kayıt yok" görünür. *Yol:* böyle bir seti `--set` ile verin.
- **Yedek kümesinin göreli yolu yanıltıcı bir mesajla reddedilir.** Mutlak yol kullanın.
- **Ledger yükseltmesinden sonra eski bir Deckent'e dönemezsiniz;** yükseltmeden önce alınan yedeği geri yüklemeden olmaz
  (yeni ledger sürümlerini eski derlemeler açamaz).
- **Günlük yedek ayarı ledger yükseltmesinden hemen önce yedek almaz.** `backup.schedule` tek değer alır (kapalı, günlük ya da
  yükseltme öncesi); günlük seçiliyse yükseltme yeni set almadan başlar ve dönüş yolu en yeni günlük settir, en fazla yaklaşık bir
  gün eskidir. *Yol:* yükseltmeden önce `deckent backup create --scope <id> --set <mutlak yol>` komutunu kendiniz çalıştırın ya
  da günlük yerine yükseltme öncesini seçin.
- **Kaybolan bir işçi slotunu tutabilir.** Verilmiş bir deneme, saklama çözülene kadar etkin kalıp bir yürütme slotunu tutabilir.
  *Yol:* `deckent monitor` ile izleyin; slot yalnız tipli manuel kararla ya da işçinin bittiğine dair kanıtla bırakılır.
- **Temiz makine provası model adımında durdu.** 2026-10-15/16'da taze bir klon kurulum, `doctor`, politika, kayıt defteri ve
  havuza ulaştı. Model bağlantısı, `/do`, boş bir Docker daemon'unda işçi imajı derlemesi ve temiz daemon'da başlangıç
  araç zinciri tazelemesi orada denenmedi. *Yol:* README'deki ilk iş yolunu izleyin ve farkı bildirin.
- **Yeniden başlatma kurtarması bağımsız incelemeden geçmedi:** gerçek konteyner öldürme ve servis yeniden başlatmasıyla.
- **`service.identity`'yi ayarlayan bir yükseltmeden sonra çalışan servis bir kez elle durdurulmalıdır** (`deckent runtime serve`
  üzerinde Ctrl+C ya da boşta durma); ancak ondan sonra `runtime restart` çalışır: servis kimliğini yalnız başlarken okur.
- **Servis kimliği ve saat.** Kurulum kimliğinin ilk yayımında nadir bir pencere kalıyor; tolerans içindeki yavaş bir saat
  kayması algılanmaz; durdurulan bir çalıştırmanın `cancelled` bildirdiği tek bir overlay durumu yeniden üretilemedi.
- **Bu sürümden önce onay bekleyen ve yalnız görev düzeyindeki bir onay kuralı yüzünden bekleyen bir /do planı yükseltmeden sonra
  devam etmez:** yeniden gönderilince park edilir (`APPROVAL_CONFLICT`). *Yol:* yeni bir /do başlatın; görev onayı bu kez görev
  çalışmadan hemen önce bir kez sorulur. Politikasında `task` kuralı olmayan kurulumlar etkilenmez.
- **Yeniden başlatma parmak izi.** `restart-exempt.json`, her istekte yeniden okunan yeniden başlatma bölümü üyelerini listeler (`admission.registry`); bunları değiştirmek hizmeti asla eski göstermez. Üye ancak başlangıçta yakalanmadığı kanıtlandıktan sonra eklenir.
- **`runtime restart`, systemd'nin çalıştırdığı hizmeti yalnız systemd bunu doğrularsa reddeder** (Linux): hizmet sürecinin control group'u aday bir `.service` unit'i gösterir; yeniden başlatma, yalnız systemd bu süreci unit'in MainPID'i olarak bildirirse reddedilir ve `systemctl [--user] restart <unit>` komutu söylenir (`systemctl show -p MainPID`, 2 sn sınır; hedef servis sürecinin ortamı hiç okunmaz). Erişilebilir bir systemd bus'ı yoksa ya da yanıt gelmezse denetim kapalıdır ve yeniden başlatma yapılır; ExecStart sarmalayıcısı runtime'ı `exec` etmeyen bir unit algılanmaz. Diğer hizmet yöneticileri ve Linux dışı hostlar algılanmaz. *Yol:* systemd'nin çalıştırdığı hizmeti `systemctl [--user] restart <unit>` ile yeniden başlatın.
- **Yerel runtime soketinin eş canlılık tanığı** HUP/ERR/NVAL'i, çağrı süresince yakalanabilir sinyalleri bloklayan sıfır süreli tek bir `ppoll` ile gözler: SIGCHLD gibi ele alınmış bir sinyal artık kopmuş istemci gibi okunmaz. Gerçek bir tur iptalinden önce biten araç çağrısı yine `cancelled` bildirilir; sonuç metni uygulanan yazım kümesini taşır (tamlık bayrağı ya da yeni durum kararı owner'da açık).
- **Yeni sürüme geçişten önce başlatılan MCP ve terminal süreçleri önceki derlemeyle çalışmayı sürdürür.** Geçiş kurulu derlemeyi
  değiştirir, ama bir istemcinin daha önce başlattığı MCP sunucusu ya da `deckent` terminali, istemci onu yeniden başlatana kadar
  yüklediği kodu kullanır. *Yol:* geçişten sonra istemciyi yeniden başlatın (Claude Code oturumu ya da terminali kapatıp yeniden
  açın); servisin hangi derlemeyle çalıştığını `deckent runtime describe` gösterir.

## Masaüstü ve diğer yüzeyler

- **Masaüstü uygulaması, web paneli ve uzak HTTP API yok.** Terminali, `deckent` komutunu, MCP'yi ya da SDK'yı kullanın.
  `deckent monitor` salt okunur canlı bir görünümdür. Masaüstü beta sonrası için planlı.
- **`deckent runtime` servisin ne zamandan beri çalıştığını göstermez.** Çalışma protokolü (v29) başlangıç zamanı taşımaz; bir
  sonraki protokol sürümünü bekler. Durum yalnız derleme, yapılandırma, çalışan işler ve soketi gösterir.
- **Monitor yalnız inceleme izniniz olan havuzları gösterir** (`pool inspect`); diğer havuzlar tek bir sayı olarak görünür
  ("Diğer işler: N havuz size gösterilmiyor"), adı, kapasitesi ve tutanı gösterilmez. *Etki:* görebildiğiniz bir Run, inceleyemediğiniz
  bir havuzda bekliyorsa havuz bekleme nedeni görünmez. İlk kurulum şablonu v13'ten önce MCP aktörünün kurallarında `pool inspect`
  yoktur, MCP üzerinden `inspect_monitor` yalnız bu sayıyı gösterir; v13 (yeni kurulumda ya da `deckent init policy --upgrade`
  sonrası) ona kurulu kapsamda `pool inspect` verir. *Yol:* bir yöneticiden o havuz için `pool inspect` isteyin;
  `deckent pool status` aynı kararı kullanır.
- **Config penceresi seçenekleri ilk kareden önce yükler.** PATH'te Docker varsa yerel imaj listesini bekler (burada 43 imaj için
  yaklaşık 0,7 sn, ilk kare toplam 2,2 sn); seçenekler henüz anahtar açılınca yüklenmiyor. Liste süre sınırına takılırsa o ana kadar
  doğrulanan imajlar önerilir ve anahtar listenin eksik olduğunu söyler ("Süre sınırından önce bulunan N seçenek gösteriliyor"); boyut sınırına takılan liste
  (`inspection.maxPageSize` imaj ya da dizin girdisi, 256 PATH dizini) "Boyut sınırından önce bulunan N seçenek gösteriliyor" der; terminal
  dışında değersiz `deckent config set <anahtar>` reddinde aynısını söyler ve `--json` bunu `params.partial` (`time` | `size`) ve
  `params.found` olarak taşır; dal ve havuz listeleri `inspection.maxPageSize`'da hâlâ sessizce kesilir; ikinci
  kimlik okumasında yoğun bir daemon hiç imaj önermez. *Yol:* listenin ulaşmadığı imaj için
  `deckent config set execution.docker.imageId '"sha256:…"'`; `deckent config explain execution` şemayı gösterir.
- **Kurulum teklifi yalnız çıplak `deckent` içindir.** Kurulumsuz bir klasörde `deckent --full-access` ve `deckent terminal`
  `TERMINAL_SCOPE_REQUIRED` vermeye devam eder. *Yol:* çıplak `deckent` ya da `deckent init` çalıştırın.
- **Monitor okuyamadığı kapsamın adını yalnız `monitor inspect-scope-diagnostics` iznine sahip izleyiciye gösterir.** Bu izleyici
  (v13: kurucu yönetici; yeni kurulumda ya da `deckent init policy --upgrade` sonrası) reddedilen ya da okunamayan her kapsamı adı ve
  nedeniyle görür (metinde ve pencerede ilk beşi, sonra `deckent monitor --verbose` komutunu gösteren tek bir "…ve K kapsam daha"
  satırı; `--verbose` ve `--json` hepsini listeler); MCP aktörü dahil diğer herkes yalnız sayı görür ("N kapsama erişim reddedildi", "N kapsam okunamadı (<kod>)"). İzin
  denetiminin kendisi başarısız olursa herkes sayıları ve tek bir "kapsam adlarını görme izni denetlenemedi" satırını görür. *Yol:*
  kural (`first-run-monitor-scope-diagnostics`) sıradan politika verisidir; yönetici onu yönetilen bir politika değişikliğiyle verir
  ya da geri alır. Başarısız kontrol için `deckent doctor` ve kod.
- **Monitor bir servisin derleme zamanını ve sürüm numarasını göstermez.** Servis yalnız commit'ini ve kaynak ağacını bildirir;
  Kurulumlar `build <commit> · kaynak ağacı <özet>` gösterir. *Yol:* servisi çalıştıran makinede `deckent --version`.
- **Etkileşimli `deckent monitor` boştayken de biraz CPU kullanır; iş defteri değiştirdiği sürece eskisi kadar kullanır.** Run'ları,
  işçileri ve izin kararlarını yalnız defter, politika, bağlamalar ya da yapılandırma değiştikten sonra (ve değişiklikten sonraki
  yenilemede bir kez daha) yeniden okur. İşçi dosyaları, süreç durumu ve model kullanılabilirliği her yenilemede okunur
  (`inspection.workers.heartbeatMs`, varsayılan 2 sn); Ayarlar sekmesi yalnız açıkken okunur. 2.000 Run'lık bir test kurulumunda
  ölçüldü: hiçbir şey değişmezken bir çekirdeğin yaklaşık %9–10'u (önce %31–34); canlı bir kurulum ölçülmedi. Terminalin
  `/monitor` penceresi, `--once`, `--json` ve MCP her çağrıda her şeyi okur. *Yol:* `p` ile duraklatın, `r` ile tam yeniden
  okuyun ya da `deckent monitor --once` kullanın.
- **`deckent run list`, `report` ve Run seçicileri yalnız `/runs` sorgusunun döndürdüğü Run'ları gösterir** (en yeni önce, en çok
  `inspection.workers.maxEntries`) ve her birini `/runs` gibi bir kez okur; kısa kimlik yalnız bu Run'lar arasında çözülür, daha eski
  bir Run tam kimliğini ister. Büyük bir kapsamda ölçülmedi. *Geçici çözüm:* `deckent run inspect --id <tam kimlik>`; `deckent
  inventory` saklanan tüm kayıtları sayfalar.
- **`deckent doctor` Docker'ı `deckent init` ile aynı biçimde sınar** (PATH'te CLI, erişilebilir hizmet, izniniz) ve yalnız okur:
  hiçbir şey kurmaz, başlatmaz, indirmez. Erişilemiyorsa, `execution` bölümü yapılandırılmışsa hata, değilse uyarıdır; algılama süresi
  içinde yanıt gelmezse "sınanmadı" der. `deckent init`'in kendi son denetimi bu sınamayı yinelemez. Etkileşimli doctor yalnız mevcut
  bir ürün komutunun uyguladığı düzeltmeleri önerir (bugün: worker araç güncellemesi); kurulum klasörünü özel yapmak kendi politika
  eylemini bekler, bu yüzden o satır sizin çalıştıracağınız `chmod 700 <klasör>` adımını gösterir.
- **Kurulumu okuyan komutlar yaklaşık 0,45–0,6 s'de açılır** (`doctor`, `config`, `operation`, `approval`, `run`, terminal); 16
  çekirdekli bir makinede Node ~1400 modül yükler. `--version` ve yardım yaklaşık 0,12 s'de açılır. Diğer komutların daha hızlı
  açılması beta sonrası açık bir owner kararıdır (paketleme ya da modül sınırı değişikliği).
- **`deckent monitor --once` bir özettir.** Sayıları, tabloları ve duran her Run'ın nedenini basar; bir işçinin tam ayrıntısı (iş
  metni, rapor iddiaları, transcript kesiti) `--once --verbose` ile gelir (terminalde `/monitor --verbose`). Bir kişiyi bekleyen işçi
  ayrıntısını her zaman gösterir. `--json` değişmedi ve her şeyi taşır.
- **Başlığı kaydedilmemiş bir Run** (teslim kuyruğu doğrulama Run'ı başlık kaydetmez) görevi ve türüyle gösterilir, örneğin
  `readme-clone-note (verify işi)`; terminaldeki `/runs` penceresi hâlâ "Başlıksız iş" der.
- **`deckent terminal status` sohbet modeline bağlanmaz,** bu yüzden erişim "sınanmadı" görünür; `deckent` içindeki ilk yanıt ya da
  `/provider` kontrolü gösterir. Bağlam penceresi ilk yanıt ölçülene kadar "?" görünür.
- **`deckent workers watch` satır seçmeye izin vermez.** Terminalde tek pencereyi yeniden çizer (Esc ya da q kapatır); ayrıntı
  `deckent workers --verbose` ile gelir. `--json`, `--all` ne derse desin geçmiş dahil tüm gözlem raporunu döndürür.
- **SDK hâlâ ham yazıcıları da dışa aktarır,** yönetilenlerin yanında; sonraki sürümlü bir SDK sözleşmesinin yalnız
  yönetilenleri bırakması hedeflenir.

## Eşzamanlılık ve ölçek

- **Burada hiçbir şey ölçek altında ölçülmedi.** Yerel kontroller filo ölçeğinde performansı kanıtlamaz. İşçi havuzunun
  yapılandırılmış bir slot sayısı vardır (`executionSlots`, `inFlightSlots`).
- **İşçiler arasındaki çakışmalar teslimde yakalanır, çalışırken önlenmez.** İki işçi ya da bir işçi ve bir kişi aynı
  dosyaları düzenlerse yama tabanı kontrolünde karşılaşır. Kaynak kilidi dışarıdaki bir kişiyi ya da bir ERP yazıcısını durdurmaz.
  Tek bir Run içinde beyan edilen kapsam yolları ya da iş kayıtları kesişen görevler artık art arda çalışır (kart sırayı gösterir);
  farklı Run'ların görevleri ve dallı bir Run'ın görevleri başlamadan önce hâlâ yalnız teslimde karşılaşır. Beyan edilen kayıt
  `resources` alanı işi sıralar ama işçide henüz zorlanmaz.
- **Tabanı ilerlemiş bir teslim bir kez, yalnız teslim niyetinizle yeniden denenir.** `deliveryIntent: "service-reattempt"` ile
  kuyruğa alırsanız servis o görevi güncel tabanda yeni bir Run olarak bir kez yeniden çalıştırır. Zincirli görev, öncülü
  benimsendikten sonra yeniden çalışır. Yeniden çalışan görev aynı iki teslim kartını alır. Niyet yoksa ya da sınır aşıldıysa
  (`targetQueue.reattempts`, varsayılan 1) yeni denemeyi siz oluşturursunuz. İş birleştirilmez, yeniden çalıştırılır; bu ikinci
  bir işçi çalışması demektir. Etkisi kanıtlanmamış ya da çözülmemiş görevler hiç yeniden çalıştırılmaz. `/deliver` penceresi
  niyeti her zaman gönderir ve bunu bir satırla söyler; `r` ile güncel tabanda hazırlamayı sunan reddedilmiş önizleme ekranında da.
  `targetQueue.reattempts` 0 ise niyet gönderilmez, satır gösterilmez. Bu ayar satırla tuşunuz arasında değişirse istek o anki ayara uyar.
- **Bir Run'ın teslim niyetini yalnız siz, öneri JSON'unda verebilirsiniz.** `deckent run propose` ile `delivery: { target,
  mode: "enqueue-accepted" }` Run kartınızı açar; sonra servis kabul edilen her görevi kartlarınız için kuyruğa alır, herhangi bir
  etki başlamadan duranı yeniden sıraya alır (en çok `targetQueue.requeueMax`, varsayılan 2) ve çakışmada bir kez yeniden dener.
  `/do` için henüz seçenek yok; bir AI (MCP) önerici niyet taşıyamaz (MCP `propose_run` bu alanı kabul etmez), AI'ın önerdiği bir plan da sizin onayınızla henüz niyet
  alamaz. Yeniden deneme Run'ının kendi biletleri yeniden sıraya alınmaz. Servis niyetli Run'ları kuyruk kirası başına bir kez okur.
- **İşçinin kaynak kullanımı yalnız sınırlı yerel izlerle ölçülür.** İşçi başına henüz maliyet ya da kalite raporu yok.
- **Defter (ledger), her sürecin paylaştığı tek bir yerel SQLite dosyasıdır.** Yazmalar sırayla yapılır; `storage.sqlite.busyTimeoutMs`
  süresinden (varsayılan 5 saniye) uzun bekleyen bir yazma `ATTEMPT_STORE_BUSY` ile reddedilir ve hiçbir şey yazılmaz. *Geçici çözüm:*
  komutu yeniden çalıştırın; yavaş ya da çok yüklü bir makinede süreyi `.deckent/config.json` içinde artırın. Açılışlar artık yazma kilidini
  beklemez ve çalışan servis defterin yan dosyalarını yerinde tutar; bu, filo ölçeğinde değil, yüklü tek bir çekirdekte ölçüldü.
