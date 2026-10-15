# Bilinen sınırlar

[English](known-limits.md) · [README](../README.tr.md) · [Mimariye genel bakış](architecture-overview.tr.md)

Bu sayfa Deckent'in henüz neyi yapmadığını, neyin denenmediğini ve onun yerine ne yapmanız gerektiğini açıkça söyler.
Yayında olan ön sürümü, `1.0.0-alpha.38`'i anlatır. Bir sınır bu sayfadan ancak onu kapatan değişiklik indiğinde ve
çalıştığı görüldüğünde çıkar, daha önce değil. Her madde sınırın **ne** olduğunu, size **etkisini** ve varsa bir
**yolunu** verir. [CHANGELOG.md](../CHANGELOG.md) her sürümün o günkü sınırlarını listeler.

Deckent bir ön sürümdür. Buradaki hiçbir şey tarih vaadi değildir.

## Platformlar: denenenler ve denenmeyenler

- **Denenen:** Linux ve WSL2 üzerinden Windows (desteklenen yürütme yolu). Barındırılan (hosted) kontroller Ubuntu'da Node 24 ve
  Node 26 ile çalışır.
  *Etki:* davranışın gözlendiği tek yerler bunlardır.
- **Desteklenmeyen: native Windows runtime.** Servis taşıması orada çalışmaz ve dosya tabanlı gizli depolar orada yoktur.
  *Yol:* WSL2 kullanın.
- **macOS'un doğrulaması ayrı ve eksiktir.** Zorunlu kontrollerin parçası değildir. *Etki:* orada yürütme ve güvenlik davranışı
  kanıtsızdır; gerçek iş için buna güvenmeyin.
- **Terminal ekran düzeni** fiziksel Windows Terminal, macOS Terminal, VS Code terminali ya da tmux'ta **denenmedi.**
  *Etki:* giriş çubuğu, pencereler ve renkler orada bozulabilir. *Yol:* düz bir Linux ya da WSL2 terminali kullanın.
- **arm64 yayımlanmıyor.** Kilitli bubblewrap paketi x86_64 için gelir; arm64 derleme kontrolü arm64 çalışma kanıtı değildir.
  *Yol:* x86_64 kullanın.
- **Henüz npm paketi yok.** Kaynaktan kurarsınız ([Başlarken](../README.tr.md#başlarken)).
- **Bazı kurulum mesajları yalnız İngilizce** (derleme ve sandbox hazırlığı mesajları çeviri var olmadan önce çıkar).

## Yalıtım

- **Docker işçisi sanal makine değildir.** Host çekirdeğini paylaşır. *Etki:* çekirdek düzeyinde bir kaçışı Deckent
  sınırlamaz. microVM sandbox'ı planlıdır, yapılmadı.
- **Kodlama işçisinin kendi araçları Deckent'in model giriş yolunun dışındadır.** Claude Code, Codex ve Cursor konteyner
  içinde kendi araçlarını kullanır. *Etki:* bu araç çağrılarına Deckent'in çağrı başına onay pencereleri karar vermez; onları
  konteyner, çalışma kopyası ve teslim kapısı sınırlar. *Yol:* işçilere yalnız çalışma kopyasını ve işin gerektirdiği izinleri verin.
- **Ubuntu 24.04 ve sonrası sandbox'ı engelleyebilir.** `kernel.apparmor_restrict_unprivileged_userns` `1` ise bubblewrap
  başlayamaz; Deckent görünür biçimde Landlock'a düşer ve tam erişimli kabuk çağrılarını reddeder. *Yol:* bir yönetici
  bubblewrap'ı root sahipli `/usr/local/bin/bwrap` olarak, ona `userns` izni veren bir AppArmor profiliyle kurar
  ([Başlarken](../README.tr.md#başlarken)).
- **`prefer-sandbox` host yedeğinin zorlanan bir dosya sistemi sınırı yoktur.** Kapalı modlarda kullanılabilir sandbox
  yoksa çağrı host'ta çalışabilir. *Yol:* sınırlama gerekiyorsa `require-sandbox` seçin.
- **Kimlik bilgisi ve ev dizini gizleme sınırlıdır.** Ortak kayıt gh, Docker, kube, Codex, Git kimlik bilgileri ve yaygın
  bulut CLI'larını kapsar; gizleme 3 derinlikte ve 20.000 girdide durur. *Etki:* özel konumlar ve olağandışı dosya adları
  maskelenmez. *Yol:* böyle dosyaları sandbox'ın gördüğü ev dizininin dışında tutun ya da ayrıca yalıtın.
- **Sır kapısı Git geçmişini taramaz.** İş gönderilmeden önce işçinin aldığı her şeyi (çalışma kopyası, `.git` üst verisi,
  bağlamalar, görev girdileri, istem bağlamı) tarar ve bulursa reddeder; nesne deposundaki eski commit'ler taranmaz. Hariç
  tutmalar yalnız ayarda yazılı yollardır, denetime yazılır ve Run kartında görünür. *Yol:* geçmişe girmiş sırları
  geçmişten çıkarın ve değiştirin; isteğe, istem metnine ya da `DECKENT.md`'ye asla kimlik bilgisi koymayın.
- **Sır kapısının ayar kuralı yalnız ayar türü dosyalara bakar.** Sıradan kaynak koduna yazılmış bir parola yakalanmaz.
  *Yol:* sırları bir sır deposunda tutun, kaynak kodda değil.

- **Kendi işletim sistemi hesabınızla çalışan bir yapay zekâ ajanı Deckent onaylarıyla sınırlanmaz.** Onay ve denetim
  kayıtları hesabınızda duran bir anahtarla mühürlenir, etkileşimli terminal denetimi bir insanı değil bir terminali
  kanıtlar ve policy dosyasını hesabınız yazabilir. Hesabınız Docker ya da sudo kullanabiliyorsa böyle bir ajan pratikte
  her şeyi yapabilir. *Etkisi:* onaylar ve policy Deckent'in kendi kum havuzundaki işçilerine karşı korur, sizin adınıza
  çalıştırdığınız başka ajanlara karşı korumaz. Beta öncesi bir denetim kontrol noktası, değişen policy'yi ya da kesilen
  denetim kaydını ayrı bir cihazın fark etmesini sağlar; donanım anahtarıyla imzalı policy ve onaylar beta sonrası gelir.
  *Çözüm:* başka yapay zekâ ajanlarını Docker ya da sudo yetkisi olmayan ayrı bir hesapta çalıştırın, Deckent işçilerini
  kum havuzunda tutun.

## Sağlayıcılar ve abonelikler

- **Claude aboneliği:** Claude Code işçisi kendi Claude girişinizle çalışır. Abonelikli Brain (`/do`'nun arkasındaki planlayıcı)
  hazırlanıyor ve henüz yok. Claude aboneliğiyle terminal sohbeti şu an desteklenmiyor. *Yol:* terminal sohbeti ve `/do`
  planlaması için bir Anthropic API anahtarı kullanın.
- **Bugün işçi, girişinizi CLI'ın kendi kimlik dosyasını ev dizininizden okuyarak alır.** *Etki:* o dosya var olmalı ve
  Deckent tarafından okunabilmelidir. Bu yol değişebilir.
- **ChatGPT ile giriş henüz yok.** `/provider` bunu kullanılamıyor olarak listeler. *Yol:* bir OpenAI API anahtarı ya da kendi
  girişiyle bir Codex işçisi.
- **Aboneliklerden API modeline henüz otomatik geçiş yok.** Bir abonelik penceresi tükendiğinde Deckent kendiliğinden ücretli
  bir API'ye geçmez; bildirilen aday listesi üzerinden yönlendirme planlı. *Yol:* bir API modelini kendiniz bağlayın ve seçin.
- **Doğrulanmış yayımlanmış fiyatı olmayan uzak model kilitlidir.** Zhipu GLM Çin, fiyatları CNY olduğu için kilitli kalır.
  DeepSeek yayımlanmış tepe fiyattan kesinleşir ve üst sınır olarak etiketlenir. *Yol:* fiyatı olan ya da yerel bir model kullanın.
- **Deckent sağlayıcı tarafındaki ayarları göremez.** OpenRouter için "Prevent overrides" eklenti ayarını ya da OpenRouter kredi
  sınırınızı göremez. *Yol:* ilk ücretli çağrıdan önce ikisine de kendiniz bakın.
- **OAuth ile MCP sunucuları desteklenmiyor.** Streamable HTTP sunucuları OAuth olmadan çalışır. *Yol:* yerel bir stdio sunucusu ya da
  OAuth gerektirmeyen bir HTTP sunucusu kullanın.

## Bütçe ve harcama

- **Tüm bir Run için harcama tavanı yok.** Her ücretli model çağrısı kapsamın USD bütçesinden en pahalı geçerli fiyatla pay
  ayırır, ama uzun süren bir API işçisinin harcayabileceği toplamın sınırı yoktur. *Etki:* API işçisindeki bir Run kapsam
  bütçesini tüketebilir. *Yol:* küçük bir kapsam bütçesi ve sağlayıcınızda bir kredi sınırı belirleyin.
- **Abonelik ve yerel modeller USD bütçesiyle ölçülmez.** Bir abonelik ya da yerel model bütçe olmadan çalışmaya devam eder.
  *Etki:* sınırları Deckent'in değil, sağlayıcı planınızın sınırlarıdır.
- **Sağlayıcı başına harcama sınırı yapılmadı.** Kapsam başına tek ortak USD bütçesi var. *Yol:* sınırları her sağlayıcı
  hesabında belirleyin.
- **Kesinleşen harcama Deckent'in kendi hesabıdır:** sağlayıcının bildirdiği kullanım çarpı doğrulanmış fiyat. Sağlayıcının
  faturası değildir.
- **Son kullanımı hiç bildirilmeyen çağrı tutulu kalır;** `deckent models reconcile-spending` ile çözene kadar.

## Teslim ve dala alma

- **Teslim ve dala alma yalnız Git içindir.** Bir çalışma hedefi tek bir Git deposudur (tam bir tane desteklenir). *Etki:* bir
  iş sistemindeki iş için teslim yüzeyi yoktur; sonuçları yama gibi teslim edilmez.
- **Checkout edilmiş bir dala dala alma yapılamaz.** Dala alma yalnız hiçbir çalışma ağacının kullanmadığı bir dalı ilerletir;
  üzerinde çalıştığınız dal (çoğu zaman `main`) reddedilir. *Yol:* ayrı bir dal açın (`git branch deckent/first-job HEAD`),
  onu `execution.adoption.targets` içine yazın ve birleştirmeyi kendiniz yapın.
- **Aynı dala ikinci teslim reddedilir,** dal hâlâ teslim tabanında değilse (`ADOPTION_BASE_CHANGED`). Deckent sizin için
  rebase ya da merge yapmaz. *Yol:* güncel tabanda yeniden teslim edin.
- **Bayat bir checkout'ta üretilen yama uygulanmayabilir.** Teslim kontrolü, bir şey yazılmadan önce durdurur.
  *Yol:* isteği güncel kaynakla yeniden çalıştırın.
- **Terminalde geri alma penceresi yok.** Dala almayı geri almak, dala almanın komut kimliğini isteyen bir komut satırı
  adımıdır ve terminaldeki dala alma gösterilmeyen bir kimlik üretir. *Yol:* teslimi ve dala almayı seçtiğiniz kimliklerle
  komut satırından yapın ([Adım adım ilk işiniz](../README.tr.md#adım-adım-ilk-işiniz)); ya da dalı `Benimsendi:`
  satırındaki commit ile Git'te kendiniz geri taşıyın.
- **Teslimden sonra terminal penceresi o görev için yeniden açılmaz;** bazı mesajlar `/deliver`'ın yeniden açtığını söylese de.
  *Yol:* önceki maddedeki gibi komut satırından dala alın.
- **Terminaldeki dala alma penceresi bir doğrulama Run'ı seçemez.** Kurulumunuz dala almadan önce doğrulanmış bir Run
  istiyorsa komut satırından `--verification-run` ile dala alın.
- **Varsayılan olarak dala alma, doğrulamaya değil kayıtlı kabule dayanır.** `Benimsendi:` satırı bunu söyler.
  *Yol:* doğrulama Run'ı zorunlu olsun diye `execution.adoption.verification` ayarlayın.
- **Run oluşturma onay kartı her satırı doldurmaz.** Risk ve Geri alma satırları aracın bunları sınıflandırmadığını ya da
  bildirmediğini söyler. *Yol:* planı ve kabul ölçütünü okuyun; Run oluşturmayı onaylamak sonucunu kabul etmek değildir.
- **Komut satırındaki `deckent do` siz onaylayınca devam etmez.** Öneriyi planlar ve kaydeder; karardan sonra aynı komutu aynı
  `--command-id` ile yinelersiniz; kimlik basılmaz, bu yüzden `--command-id` ile kendinizinkini verin. Terminalde `/do` kendiliğinden
  devam eder.
- **Soru soran bir işçiye terminalden cevap verme henüz yapılmadı.**
- **Otonom teslim tasarlandı ama kapalı.** Her teslim ve dala alma, doğrulanmış bir terminalde sizin `y`'nizi ister.

## ERP ve operasyonlar

- **ERP bağlayıcısı yok.** Operasyon sözleşmesi (niyet, koşullu yazım, tekrarsız yeniden gönderim, kanıtla kabul, telafi) ve
  uzantı girişi var; IFS, SAP, Oracle, Microsoft, Uyumsoft ya da Logo adaptörleri yok. Çalışan tek örnek hedef bir test
  fixture'ıdır. *Etki:* ERP etkilerini çalıştırmak için kendi adaptörünüzü yazmalısınız.
- **`deckent operation list` yok.** Tek bir operasyona `deckent operation inspect --scope <id> --command-id <id>` ile
  bakabilirsiniz, yani kullandığınız komut kimliklerini saklamalısınız. *Etki:* bekleyen ve belirsiz etkiler listelenemez.
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

## Kurtarma ve yükseltme

- **Yedek kümeleri tamamen şifreli değildir.** Kümenin içindeki yalnız yetki anahtarı parolanızla şifrelenir; ledger ve durum
  arşivi düz dosyadır. *Yol:* kümeleri şifreli depolamada saklayın, parolayı ayrı tutun.
- **Geri yükleme yedek zamanlamasını kapatır** ve sağlayıcı anahtarları ile yedek parolası kümede değildir. *Yol:* geri
  yüklemeden sonra `backup.schedule`'ı yeniden seçin ve her anahtar için `deckent secret set` çalıştırın.
- **Geri yükleme servisin durmuş olmasını ister** ve mesaj komutu söylemez. *Yol:* `deckent runtime shutdown --service <id>
  --instance <id> --command-id <id> --reason <metin>`, açık terminalleri kapatın, sonra geri yüklemeyi yeniden çalıştırın.
- **Yedek kümesinin göreli yolu yanıltıcı bir mesajla reddedilir.** Mutlak yol kullanın.
- **Ledger yükseltmesinden sonra eski bir Deckent'e dönemezsiniz;** yükseltmeden önce alınan yedeği geri yüklemeden olmaz
  (yeni ledger sürümlerini eski derlemeler açamaz).
- **Kaybolan bir işçi slotunu tutabilir.** Verilmiş bir deneme, saklama çözülene kadar etkin kalıp bir yürütme slotunu tutabilir.
  *Yol:* `deckent monitor` ile izleyin; slot yalnız tipli manuel kararla ya da işçinin bittiğine dair kanıtla bırakılır.
- **Yeniden başlatma kurtarması bağımsız incelemeden geçmedi:** gerçek konteyner öldürme ve servis yeniden başlatmasıyla.
- **Servis kimliği ve saat.** Kurulum kimliğinin ilk yayımında nadir bir pencere kalıyor; tolerans içindeki yavaş bir saat
  kayması algılanmaz; durdurulan bir çalıştırmanın `cancelled` bildirdiği tek bir overlay durumu yeniden üretilemedi.

## Masaüstü ve diğer yüzeyler

- **Masaüstü uygulaması, web paneli ve uzak HTTP API yok.** Terminali, `deckent` komutunu, MCP'yi ya da SDK'yı kullanın.
  `deckent monitor` salt okunur canlı bir görünümdür. Masaüstü beta sonrası için planlı.
- **SDK hâlâ ham yazıcıları da dışa aktarır,** yönetilenlerin yanında; sonraki sürümlü bir SDK sözleşmesinin yalnız
  yönetilenleri bırakması hedeflenir.

## Eşzamanlılık ve ölçek

- **Burada hiçbir şey ölçek altında ölçülmedi.** Yerel kontroller filo ölçeğinde performansı kanıtlamaz. İşçi havuzunun
  yapılandırılmış bir slot sayısı vardır (`executionSlots`, `inFlightSlots`).
- **İşçiler arasındaki çakışmalar teslimde yakalanır, çalışırken önlenmez.** İki işçi ya da bir işçi ve bir kişi aynı
  dosyaları düzenlerse yama tabanı kontrolünde karşılaşır. Kaynak kilidi dışarıdaki bir kişiyi ya da bir ERP yazıcısını durdurmaz.
- **İşçinin kaynak kullanımı yalnız sınırlı yerel izlerle ölçülür.** İşçi başına henüz maliyet ya da kalite raporu yok.
