# AI asistanıyla Deckent kurulumu

[English](ai-install.md) · [README (EN)](../README.md) · [Bilinen sınırlar (EN)](https://github.com/Verhex/deckent-next/blob/main/docs/known-limits.md)

Bir kişi Deckent kurmanızı istediğinde bu rehberi kullanın. Hedef klasörünü ve doğrulanmış paket dosyasını öğrenin.
Deckent kişinin altyapısında çalışır; kurulum kişinin iş operasyonlarını yürütme izni vermez.
Bu rehber alpha.58 adayının (`f6b119d4f`; 2026-10-29'da `0ba89deab` olarak yayımlandı) CLI yardımı ve kaynağıyla yeniden kontrol edildi; alpha.59 (2026-10-30'da `4d12d6fa8` olarak yayımlandı) ve alpha.60 adayı kullandığı hiçbir CLI komutunu değiştirmez. npm paketinin ya da sitenin yayımlandığı iddiası değildir.
Son yayımlanan sürümün kaynaktan kurulum yolu README'dedir.

## Hazırlık ve kurulum

x86_64 üzerinde Linux ya da WSL2 kullanın. Native Windows desteklenmez; macOS çalışma zamanı desteği eksiktir.
Mevcut paket Node.js `>=24.22.1 <25 || >=26.12.1` ve npm ister. Kurulumdan önce dosyanın `package.json` engines alanını
yeniden kontrol edin; Node 25 kapsam dışıdır. Kod işçileri ve imaj derlemek için Docker kurulu, çalışıyor ve erişilebilir olmalıdır.
Yerel model sohbeti kendi başına kod işçisi gerektirmez. İşletim sistemi izinlerini değiştirmek ya da Docker'ı yükseltilmiş
yetkiyle kurmak gerekiyorsa yönetici adımını kişiye bırakın.

Deckent henüz npm'de yoktur. Kişinin kaynağına ve bütünlüğüne güvendiği paket dosyasını edinin. Aşağıdaki örnek tarball yolunu
bu dosyanın mutlak yoluyla değiştirin; dosya adı yer tutucudur. npm paket adı tahmin etmeyin ya da doğrulanmamış alternatif
indirmeyin. npm yayını olduğunda doğrulanmış paket kimliğini ve sürümünü kullanın.

```sh
npm install --global /absolute/path/to/deckent-package.tgz
```

Aşağıdaki adımları kişinin seçtiği proje klasöründe, Deckent kaynağının dışında çalıştırın. `my-project` yerine kalıcı kapsam
adını yazın. Kapsam politika ve kayıtları gruplar; sandbox değildir. Bu adım yeni kurulumun dilini ve izinlerini yazar;
kimlik profili seçmez, giriş yapmaz, anahtar girmez ve kart onaylamaz.

```sh
deckent init --yes --scope my-project --json
deckent doctor --json
```

JSON'un tamamını ve süreç çıkışını okuyun. Kurulumun bitmesi başlangıç adımlarının bitmesinden ayrıdır.
Başsız kurulum yetkiyi beklemede bırakır; kişinin tanıklı ilk terminal açılışı profil ve izin varsayılanlarını önizler.
Kurulum sıfır döndü diye “hazır” demeyin. Doctor eksik model, işçi yapılandırması, uyarı ya da sınanmamış denetim bildirebilir.
Hazırlığı denetler; Docker kurmaz veya başlatmaz.

## Bu adımları kişiye bırakın

Kişinin bu klasörde `deckent` açıp başlangıç ekranlarını tamamlamasını isteyin. Şu adımlarda durup kişiye devredin:

- Kendi sağlayıcı ya da abonelik hesabına giriş ve AI/arka plan kullanımı için açık rıza. Tarayıcı oturumu veya başka birinin
  kimlik bilgisini kopyalamayın. ChatGPT ile giriş kullanan işçinin etkinleştirilmesi N1 kanıtına kadar bekletiliyor.
- Sağlayıcı sırlarını Deckent'in maskeli alanına girmek. Değeri sohbette istemeyin; argüman, ortam değişkeni, günlük,
  ekran görüntüsü veya konuşma dökümüne koymayın.
- Profil, izin kipi ve izin/onay kartlarını gerçek terminalde incelemek. AI, MCP, pipe ve JSON kişinin kararına tanıklık
  etmez. Terminal taklit etmeyin, politika dosyası değiştirmeyin ve reddi aşmak için komut değiştirmeyin.
- Ücretli API bütçesine karar vermek. İlk kurulum bütçesi sıfır USD'dir; önce harcamasız yollar sunulur. API bütçe ekranı
  kişinin kabul edebileceği ya da değiştirebileceği 10 USD seçeneği sunar; kişi adına kabul etmeyin.
- İlk kurulum şablonundan geniş kurallı bir kurulum profilini (`init apply --profile`, `init resume`) kendisi uygulamak: bu
  kişiyi terminalinde ister (`AUTHORITY_WITNESS_REQUIRED`). Yukarıdaki şablon içi `init --yes` terminalsiz kalır.
- Kaldırmayı, kademesini, `--force`, `--disable-unit` ve yedek parolasını kendisi onaylamak. Kurulum adını bilmek yetki
  vermez; `--yes` terminalindeki kişinin yerini almaz.

Kişi adımları tamamlayınca `deckent doctor --json` çalıştırıp kalan hata ve uyarıları aynen bildirin. Kapsamı,
paket dosyasının sürümünü, biten adımları, kişiyi bekleyen adımları ve sıradaki eylemi söyleyin. Doctor yeşili kurulum
kanıtıdır; sonraki ERP/CRM operasyonunun veya işçi çıktısının kabulü değildir.

## Retler ve belirsiz sonuçlar

JSON'daki tipli hata `code` alanını, güvenli açıklamasını ve sonraki adımını koruyun; hepsini “kurulum başarısız” diye birleştirmeyin.
Tanık ya da politika reddi, kişinin sunulan karttan karar vermesini gerektirir. Eksik bağlantı, bilinmeyen tarife,
kullanılamayan sandbox veya sınanmamış kontrol varsa bağımlı eylemi durdurup nedeni bildirin. Sır taşıyan ham günlükleri
paylaşmayın. Kesinti sonrası kayıtlı sonucu inceleyin; belirsiz etki çözülmemiştir, kör tekrar izni değildir.
Mevcut derleme istenen yolu sunamıyorsa bilinen sınırlar sayfasını kullanın.

## Kaldırma

Kaldırma planını uygulamadan inceleyebilirsiniz:

```sh
deckent uninstall --dry-run --json
```

Kişi gerçek terminalde `deckent uninstall` çalıştırır. Menü, her biri kendi bayrağı olan üç kademe sunar; her birini
`--dry-run` ya da `--json` ile önizleyebilirsiniz (örneğin `deckent uninstall --all --dry-run --json`):

- `--keep-data` (varsayılan): önbellekler silinir ve çalışan servis durur; iş kayıtları, ayarlar ve geçmiş kalır. Klasör emekli
  edilir: oradaki bir sonraki `deckent`, önceki veriyle devam edilip edilmeyeceğini bir kez sorar.
- `--keep-work`: konuşma verisini de (geçmiş, kayıtlar, oturumlar, çökme raporları, önizlemeler; önceki yedekler kalır) arşivleyip siler; iş kayıtları ve bekleyen
  işler kalır. Bekleyen iş varken sunulur.
- `--all`: önce parolalı bir yedek ve sildiği diğer her dosyanın şifreli arşivi, ikisi de doğrulanmış ve silinen her klasörün
  dışındaki kişisel kurtarma klasöründe; ardından projenin `.deckent` klasörü, init'in yazdığı `DECKENT.md` ve köprü satırı
  silinir. Projenin Git'inin izlediği ve tanınmayan dosyalar kalır ve listelenir; klasör yalnız boşsa silinir.
  O yedek setiyle `deckent backup restore` hepsini geri getirir.

Bütün denetimler tek onaydan önce yapılır; silinecek bir şey yoksa soru sorulmaz. Ret nedenini ve sonraki adımı söyler:
çalışan iş (`--force` kişinin kendi yetkisiyle iptal eder, sonucu bilinmeyen işlemi kapatmaz), servisi yeniden başlatan
servis yöneticisi (`--disable-unit` kullanıcı birimini kapatmaya ayrı rızadır; manager dosya ve bağlantı kümesini kanıtlar,
ledger kilidi yeni başlangıcı kapatır; birim dosyası kalır), kuyruktaki teslimler (`--all --force` her teslimin yetkisini karttan
önce kendi kuyruğunun sahibinde denetler, sonra aynı sahip üzerinden geri çeker), politika,
saklama ya da yasal saklama veya taşınmış ya da güvensiz yetki dosyası (güvensiz `policy.json` ya da `bindings.json`
`UNINSTALL_POLICY_UNREADABLE` olur: veriler kalır, dosya onarılmaz; kişi adına düzeltmeyin). Git izleme bilgisi
okunamazsa her proje dosyası izleniyor olabilir sayılır ve korunur. `--yes` yalnız son kartı atlar; plan yine yazdırılır. İşçi imajları kalır; yalnız kartın verdiği kesin komutu
kullanın. macOS/Windows servis kaldırması elledir. Yarım silme yalnız kalan baytlar ve yetki yeniden doğrulanınca sürer.

Adım sonuçlarını okuyun: kesildi, engellendi veya bilinmiyor tamamlandı değildir. Kurulum yöntemi kanıtlanınca çıktı programı
kaldırma komutunu yazar (örneğin `npm uninstall -g deckent`), yoksa genel yönerge verir. Bu son adımı kişiye bırakın;
paket adını tahmin etmeyin veya klasörleri/imajları kendiniz silmeyin.
