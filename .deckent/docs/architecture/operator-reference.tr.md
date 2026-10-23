# İşletim başvurusu

[README.tr.md](../../../README.tr.md) içindeki ürün özetinin arkasındaki ayrıntılı işletim davranışı. English: [operator-reference.md](operator-reference.md).

Etkileşimli terminal tam penceredir (terminalin alternatif ekranı, Claude Code tam ekran görünümü gibi): sohbet üst alanda
kayar, giriş barı oturum boyunca aynı alt satırda kalır (yalnız pencere boyutu ya da kendi çok satırlı taslağınız onu oynatır),
altında sabit yükseklikte bir bilgi alanı durumu, modeli ve modu, Aktif iş özetini (ya da tam erişim satırını) ve tuş
ipuçlarını gösterir. Sohbet en yeni satırı izler; fare tekerleği her çentikte üç satır, PgUp/PgDn yarım görünüm kaydırır,
Ctrl+Home ilk satıra, Ctrl+End en yeniye döner; geriye okurken bir satır kaç yeni mesaj (ya da satır) geldiğini söyler ve
End/Home en yeniye/ilk satıra atlar (akış görünümü aşağı çekmez; en altta yeniden izler). Geride okurken Ctrl+F bu görünümün
tuttuğu sohbette arar (yalnız gösterilen, maskelenmiş metin; Enter/↑ eski, ↓ yeni, Esc kapatır; taslak değişmez), Ctrl+Yukarı/
Ctrl+Aşağı önceki/sonraki mesajına atlar (Ctrl+R giriş geçmişi aramasıdır). Pencere ve kartlar giriş barının hemen üstünde açılır,
ekranın en çok yarısını kaplar ve içeride kayar; sohbet alanını daraltır, barı oynatmaz. Çıkışta sohbet normal ekrana yazılır,
böylece terminalin kaydırma geçmişinde kalır; `/clear` görünümü ve o geçmişi boşaltır. Tam pencere yalnız gösterilirken fare
tekerleğini alır (tıklamalar yok sayılır ve hiçbir kartı cevaplamaz); metni Claude Code'daki gibi terminalin değiştirici tuşuyla
seçin — çoğu terminalde Shift, iTerm2'de Option, Terminal.app'te Fn. `terminal.layout: inline` önceki satır içi düzeni korur (çalışırken
yerel kaydırma geçmişi; ekran okuyucuyla önerilir); `terminal.viewportRows` (varsayılan 2000) görünümün ne kadar geriye
kaydığını sınırlar. Mod renkleri: standart soluk, tam otomatik kendi rengi, tam erişim uyarı tonunda sakin `⏵⏵⏵` işaretiyle
(NO_COLOR: modu sözcükler taşır). Komutunuzla veya seçiminizle açılan
pencere hemen odağı alır; Escape kapatıp girişe döner. Otomatik /do planlama ve ilerleme pencereleri ile
Run/worker izlemeleri giriş odağını almaz: taslak yazabilir, Enter ile mevcut işlemin
arkasına sıraya alabilirsiniz. Ctrl+O giriş ile üst pencere arasında odağı değiştirir. Onay kartı (ve her soru) klavyeyi
kendiliğinden alır ve giriş barının yerine geçer; Ctrl+O gerekmez. Cevaplar listedir — "Evet, bu sefer (y)", "Evet, bu
oturum boyunca (s)" ve "Bu projede hep izin ver (a)" yalnız servis sunduğunda (taban öğelerinde ve her zaman sorulan
kilitlerde asla), "Hayır (n)" — ↑↓, j/k ya da 1–9 ile seçilir, Enter ile onaylanır ya da harfle cevaplanır; seçim Hayır'da
başlar, Esc reddeder. Kart, gösterildiği andan itibaren kısa bir sessiz süre (0,3 sn, `decision.json`) geçmeden tuş saymaz;
o sırada ipucu satırı "Yeni açıldı · tuşları birazdan çalışır" der (erken gelen tuş için "Tuş sayılmadı … yeniden basın"),
tuşlar sayılmaya başlayınca orada görünür:
girişe az önce yazılan tuşlar, basılı tutulan tuş, yapıştırma, az önce cevaplanan karttan ya da odak değişiminden gelen tuş
kartı cevaplamaz; birden çok tuş olayı üreten tek bir okuma asla karar vermez. Taslak korunur ve barla geri gelir. Bekleyen
kararlar tek tek gelir ("1/3"). "Hep izin ver" kendi kalıcı iznindir (`deckent policy grants --mine`, `deckent policy revoke`
ile kaldırılır). Mevcut karar, gerekçe ve doğrulanmış TTY şartları geçerlidir.
Escape odaklanmış pencereyi kapatır veya onayı reddeder; girişte mevcut taslak/iptal davranışı sürer. Uzun pencere
içeriği oklar, PageUp/PageDown ve Home/End ile içeride kayar ve satır aralığını gösterir. Çok satırlı taslak,
yükseklik bütçesi içinde imleci takip eder. Ctrl+S taslağın tamamını kenara koyar (yalnız bellekte; kaydedilmez, loglanmaz),
boş satırda geri getirir (kenardaki taslak asla üzerine yazılmaz); Ctrl+_ gönderilmemiş son düzenlemeyi geri alır (kesintisiz
yazım tek adımdır, gönderince silinir). Barın altındaki bilgi satırı sohbetin bağlam kullanımını da gösterir (`/context`
ölçümü; ilkinden önce "bağlam ?"). `/watch-stop` gözlemi kapatır. Girişin altındaki "Aktif iş" özet satırı bu
oturumun çalışan /do'sunu (planlanıyor ya da kalan onay süresiyle seni bekliyor) ve başlattığı Run'ları başlık, durum, geçen
süre ve "+N daha" ile gösterir; kendiliğinden odak almaz. Ctrl+T tam listeyi girişin üstünde açar (↑↓, Esc geri): /do üzerinde Enter penceresine odaklar, Run üzerinde
Enter o Run'ın penceresini açar; biten Run açıldıktan sonra şeritten çıkar. Pipe ve satır modu çıktısı değişmez.

## Kurulum muhafazası

Kurulum, mevcut kullanıcıya ait ve grupça yazılabilir proje/bootstrap journal dizinlerini
(örneğin `0775`) kabul eder; diğer kullanıcılara yazma izni veren dizinleri reddeder.
Grup üyeleri dizin girdilerini değiştirebilir; journal namespace muhafazası o grupla paylaşılır.
Journal dosyaları yine mevcut kullanıcıya ait, tek hard link'li ve private `0400`/`0600` izinli
olmalıdır. Yeni dizinlerin varsayılanı `0700`'dür. Config yayımı, policy, artifact ve worker
kaynakları daha sıkı, ayrı kontrollerini korur. Grupça yazılabilir proje, ortak yazılabilir ürün
veri kökünün desteklendiği anlamına gelmez.

## Worker araç sürümlerinin güncelliği

`deckent doctor --toolchains`, hazırlanmış native profillere sabitlenmiş CLI sürümlerini
`@openai/codex` ve `@anthropic-ai/claude-code` paketlerinin npm `latest` etiketiyle karşılaştırır
(paket başına tek sınırlı okuma, kimlik bilgisi olmadan). Yalnız bu bayrakla ve
`toolchains.currency.mode: report` seçiliyken çalışır. `registryEndpoint` özel registry'ye işaret
edebilir; erişilemeyen registry `unknown-offline` üretir. Cursor'ın belgelenmiş sürüm endpoint'i
olmadığından `unsupported` raporlanır. Rapor hiçbir işçiyi güncellemez, yeniden derlemez veya
etkinleştirmez. Aynı rapor MCP `inspect_toolchain_currency` aracı ve SDK
`inspectToolchainCurrency` fonksiyonuyla alınabilir.

`deckent toolchains update [--apply]`, eski sürüm raporundan bir sonraki worker image sürümünü
hazırlar. `toolchains.update.mode` değerleri `off | propose | auto`, varsayılan `auto`'dur.
Tipli plan `<data root>/workspaces/toolchains/plans/` altına yazılır. `--apply` ile (her modda; `auto` yalnız çalışan servisin kendi yenilemesine
uygulama yetkisi verir) paketli builder `workspaces/toolchains/builds/<version>/` altına kopyalanır ve sınırlı sürede derlenir;
makbuzundan uygulanmamış (`not-applied`) profil revizyon önerisi (`proposals/<version>.json`) oluşur.
Kurulu config yeniden yazılmaz; öneri yeni kurulum profil revizyonu olarak uygulanır. Çalışan iş
kendi image'ını korur; önceki sürümler geri dönüş için tutulur. `toolchains.update.atStartup`,
`runtime serve` açılışında yalnız güncellik raporunu üretir.

## Worker image sürümleri

`npm run worker:image -- /abs/path/worker-images/<version>.json`, `assets/worker-image` içindeki
üç sağlayıcılı `deckent/worker` image'ını derler. `recipe.json` (şema 2), `imageVersion`
(`r<N>-<YYYYMMDD>`) ve `previousVersion` alanlarını taşır. Dockerfile'daki en yeni sürüm başta olacak
şekilde `# version …` yorum geçmişi recipe ile eşleşmeli; bu dosya image'a
`/opt/deckent-worker/Dockerfile` olarak kopyalanır. Her sürüm, OCI etiketleriyle birlikte
`deckent/worker:<version>` olarak işaretlenen tek değişmez imageId'ye bağlanır. Aynı sürüm etiketi
başka bir image'ı gösteriyorsa işlem reddedilir. Güncelleme için geçmişe yeni satır ekleyin,
`imageVersion`/`previousVersion` değerlerini artırın, yeniden derleyin ve makbuzun `imageId` değerini
yeni execution profil revizyonunda kullanın. Eski image, etiket ve arşiv makbuzlarını
(`worker-images/archive/`) çalışan Run'lar ve geri dönüş için koruyun. Ürün yalnız `imageId` ile
bağlanır; image çekmez, etiketlemez veya silmez.

## Native coding profilleri

`coding prepare --input <file|-> --json` ve SDK `prepareNativeCodingProfile` profil hazırlar;
hazırlamak profili etkinleştirmez veya yürütme izni vermez. Dış istek şekli
`{schemaVersion: 1, template, invocation}` olarak kalır. Yeni `invocation` verisi `schemaVersion: 2`,
`provider`, `cliVersion`, `permissionMode: "unattended"`, `model` ve `prompt` ya da `composition`
alanlarından birini ister. Host CLI sürümünü değil, seçilen image'ın preflight makbuzunda ölçülen
birebir CLI sürümünü kullanın.

Yapılandırılmış `composition` v1; `task`, `scope`, `acceptance` metinlerini zorunlu tutar.
Opsiyonel `core`, `persona` ve `skills`/`context` dizilerini kabul eder; seçilen her parça
`{id, version, text}` taşır. `core` verilmezse paketli, sürümlü ortak worker talimatları seçilir.
Seçim açıktır: persona/skill kataloğu veya host dosyası aranmaz. Yinelenen persona/skill kimlikleri
reddedilir. Her metin en fazla 16 KiB, serialize edilmiş composition 32 KiB; en fazla 16 skill ve
8 context parçası olabilir. Prompt'lar görev verisi olarak saklanır; hiçbir girdi biçimine kimlik
bilgisi koymayın.

Compiler; içeriği, seçilen parça hash'lerini ve komut argümanlarını hazırlanmış profile bağlar.
Worker bağı doğrular; Claude'a core'u `--system-prompt`, Codex'e private tmpfs'te talimat dosyası,
Cursor'a görevle birlikte inline olarak verir. Codex ayrıca otomatik proje dokümanı yüklemeyi kapatır;
bu, tüm keşif davranışının engellendiğini kanıtlamaz. Docker komut argümanlarında composition prompt
metinleri yerine placeholder bulunur. Sınırlı `native-prompt-delivery` çıktısı native süreç
başlarken hash ve seçim metadata'sını kaydeder; prompt veya kimlik bilgisi içermez. Bu kayıt süreç
girdisinin teslimini kanıtlar, modelin talimata uyduğunu değil; kabul için gözlenen görev sonucu
gerekir. Persona ve skill içeriği yetki vermez.

`discovery` sürümlü veridir: varsayılan `{schemaVersion: 1, mode: "disabled"}` olur.
Claude bunu abonelikle uyumlu `--safe-mode` bayrağına çevirir. Codex ve Cursor adapter'larında tam
keşif engelleme henüz kanıtlanmadığından bu mod reddedilir. Açıkça yetkilendirilmiş repo keşif
profili için `{schemaVersion: 1, mode: "repository"}` seçin; repo talimat/config yüklemesine izin
verir, repo hook veya MCP süreçlerini başlatabilir. Ek host/ağ erişim yetkisi vermez. Keşif engelleme
otomatik yüklemeyi kontrol eder; native araçlar çalışma alanındaki dosyaları yine okuyabilir.

Şu an yalnız Claude repository modu, tipli `disableAllHooks: boolean` alanını içeren
`discovery.settings` kabul eder. Bu alan açık `--settings` JSON'una dönüşür; keyfî settings dosyası,
yardımcı program, ortam değişkeni ve kimlik bilgisi reddedilir. Hook'ları kapatmak tek başına repo
MCP veya talimatlarını engellemez. Discovery-disabled modunda settings reddedilir.

Worker, kimlik dosyasını yazıp görevi başlatmadan önce boş geçici dizinde CLI sürümünü ve gerekli
bayrakları kontrol eder. Uyumsuzluk temizlenmiş `preflight` hatasıyla çıkar; API/authentication
fallback yoktur. Mevcut image yeniden incelendiğinde de güncel inspector kullanılır ve hash'leri
kaydedilir. Capability yardım çıktısı authenticated kanıt değildir. Eski invocation-v1 hazırlama
istekleri anlamları sessizce değiştirilmek yerine reddedilir. Kalıcı execution profilleri birebir
davranışlarını ve replay'lerini korur; migration yeni profil revizyonunun açıkça hazırlanıp kabul
edilmesidir.

## Patch muhafazası ve integration

Patch capture çalışma alanını base tree ile Git object id üzerinden karşılaştırır ve yalnız değişen
base blob'ları okur. Git çıktı/süre veya tarama bütçesi tükenirse `PATCH_LIMIT` ve `detail` parametresi
(`git-output`, `git-timeout`, `time`, `bytes`, `entries`, `depth`, `path`) ile kapanır.
`execution.git.outputBytes` varsayılanı 4 MiB'dir.

Saklanan workspace patch'i için `deckent task integration-check`, kayıtlı base'i HEAD ve etkilenen
index/worktree dosyalarıyla karşılaştırır. `task patch-preview` ile aynı kimlik bayraklarını kullanın.
`task integration-prepare` ayrıca `--command-id <id>` ve check'in `--proposal <code>` değerini ister;
`prepare-integration` policy izni gerekir. Her iki komut `--json` destekler ve runtime servisi
olmadan yerel depolama kullanır.

İnsan için `deckent task` (alpha.48 C-TASK). Her `task` görünümü çağrının dilini kullanır (`--lang`, sonra
`DECKENT_LANGUAGE`, sonra config `language`, sonra sistem dili); `transcript` ve `patch-preview` biçimini korur.
`--run` kısa kimlik alır: tam kimlik ya da terminaldeki `/runs` listesindeki bir Run'ın tek eşleşen öneki çözülür;
birden çok aday `CLI_ID_AMBIGUOUS` (çıkış 2) olur; başka her değer olduğu gibi iletilir. `task inspect`, `run inspect`
sırasıyla okunur (görev ve durum, istek, sonuç, kabul edilmiş sonucun neye dayandığı, teslim); beş yoldan uzun gizli
bilgi kapısı listesi red listesi istisnalarını adlandıran tek satırdır, `--verbose` her yolu ve kabul üst veri satırını
ekler. `patch-preview` farkında kontrol karakterleri etkisizleştirilen satırın ardından
`\ üstteki satırdaki kontrol karakterleri etkisizleştirildi` üst satırı gelir (`--stat` ve `--json` değişmez). Gerçek
terminalde `--run`/`--task` verilmeyen `task inspect|transcript|patch-preview` kapsam, Run ve görev seçtirir; argümansız
`deckent task` (katalog aileyi argümansız-işleyici olarak işaretleyince) görevin yalnız geçerli eylemlerinin menüsünü
açar: deneme varsa inceleme, transkript ve fark; karar açıkken kabul/ret; teslim bekleyen kabul edilmiş yama için teslim.
Kabul/ret revizyonu kartından hemen önce okur ve komut kimliğini üretir; bu arada değişen Run reddedilir
(`RUN_STORE_CONFLICT`), yeniden okunur ve yeniden sorulur. Teslim `/deliver` ile aynı portu ve uygulamaları kullanır;
her yazma (aday + teslim, dala alma, kuyruk partisi) kendi birebir kartını bekler; yalnız Enter, Esc ya da sessizlik
(oturum onay süresi) hayır demektir. Pipe, AI ajanı, CI ya da `--json` çağıranına soru sorulmaz: argümansız
`deckent task` eksik argümanı adlandırır ve eylemleri dört grupta listeler (İncele, Yürüt ve değerlendir, Teslim,
Kuyruk), çıkış 2. AI yolu tüm uzun adları ve bayrakları korur.

İnsan için `deckent run`, `report` ve `inventory` (alpha.48 C-RUN). `deckent run list`, terminalin `/runs` penceresiyle aynı
Run kimliklerini ve her Run'ı aynı inceleme uygulamasıyla okur: bekleyen (bekletilmiş) Run'lar önce, sonra en yenisi; kısa
kimlik, `/runs` durum sözcükleri, kabul edilen görevler ve başlık; `--json` Run görünümlerini döndürür. Var olan bir Run'ı
adlandıran her `run` eylemi kısa kimlik alır (benzersiz önek; birden çok aday `CLI_ID_AMBIGUOUS`, çıkış 2; diğerleri olduğu
gibi geçer); `create --id` hiç çözülmez, yeni Run'ın adıdır. `--scope` olmayan bir okuma yapılandırılmış `terminal.scopeId`'yi
kullanır ve ilk satırda söyler; yoksa terminal dışında geçerli kapsamları sayan `CLI_SCOPE_REQUIRED` döner. `run inspect`
istek, sonuç ve görevleri okur (her görevde kabul edilmiş sonucun neye dayandığı, ör. "kabul: çıkış kodu · içerik bağımsız
doğrulanmadı", sonra teslim); yetki kaydı, maliyet özeti, kabul meta satırı, profil ve kriter satırları, tam kimlikler ve beş
yoldan uzun gizli bilgi kapısı listesi `--verbose` ile gelir. Gerçek terminalde kimliksiz `run inspect` ve `report` Run'ı
seçtirir; `--command-id`/`--expected-revision` olmadan `run cancel|hold|resume|close` kapsamı (değişiklik varsayılanı sessizce
almaz) ve Run'ı (yalnız durumu o denetimi sunan Run'lar; `/runs` tuşlarıyla aynı kural) seçtirir, revizyonu kartın hemen
öncesinde okur, kart kapsamı, Run'ı, durumu ve sonucu adıyla gösterir ve sistemin ürettiği komut kimliğiyle gönderir; `n`,
Esc ya da sessizlik hiçbir şey göndermez, arada değişen Run yeniden okunup yeniden sorulur. AI ve otomasyon yolunda tüm
yazılı bayraklar zorunlu kalır; ajana ya da boruya hiçbir zaman soru sorulmaz. `deckent report` Bilinen (sonuç, kabulün
dayandığı kanıt, okunur birimlerle süre, CPU, bellek, model) ve Ölçülemeyen (her alan nedeniyle, ör. abonelik çağrısında
çağrı başına ücret ölçülemez) bölümlerini gösterir; `--run` yoksa kapsamın son Run'larını listeler. `deckent inventory` bu
kurulumun dağıtım günlüğünün geliştirici görünümüdür (kısa kimlik, `--verbose` ile tam kimlik); `workers list` yapılandırılmış
`inspection.workers.sources` kaynaklarını da okuduğu için daha çok kayıt gösterebilir. `inspection.maxPageSize` üstü sayfa en
çok değeri söyleyen `DISPATCH_INVENTORY_LIMIT` olur. Yalın `report`/`inventory` çağrıları ve `run list` katalog deltası
uygulanınca erişilir.

Hazırlama, yapılandırılmış workspaces kaynağının `integrations` dizininde ayrı Git adayı oluşturur.
Aday kayıtlı base ve patch'i içerir; kaynak dosya, HEAD ve index değişmez. Hazırlanmış aday Task kabulü
veya canlı teslim değildir. Tamamlanmış komut tekrarlandığında aday doğrulanır; kesilmiş komut
`PATCH_INTEGRATION_PENDING` döndürür ve dosyalarını otomatik onarım/devralma olmadan korur.
Mevcut ledger'lar prepare öncesi açık installation/storage migration ile sürüm 30'a yükseltilmelidir;
salt-okunur check ve olağan hazırlama depolamayı sessizce migrate etmez.

`task integration-inspect`, aynı kimlik bayraklarıyla `--command-id <id>` alır ve yalnız `read-output`
izni ister. Mevcut ledger ve değişmez manifest'ten `absent`, `pending` veya `manifest-recorded`
raporlar. Execution config olmadan çalışır; depolamayı migrate etmez, adayı onarmaz ve mevcut aday
dosyalarını yeniden kontrol etmez.


## Kurulum kurtarma setleri

`deckent backup create|verify|restore` aynı yetkili uygulama sözleşmesini kullanır. Kurulum
sahibinin tüm kapsamlar için `backup` policy izni gerekir. Mevcut kurulumda önce
`deckent init policy --scope <id> --upgrade --preview` ile ekleme planını görün; sonra
`--apply --expect <önizlemedeki-revision>` kullanın. Çakışan kurallar değiştirilmez.
Mevcut güncel kurulumda eksik havuz: `deckent init pool --scope <id> --preview`, ardından `--apply`; kapasite config admission alanından alınır, farklı mevcut havuz değiştirilmez.

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

Parola maskeli terminal isteminden veya stdin'den okunur; komut argümanına yazılmaz.
Parolayı setten ayrı saklayın. Set; çevrimiçi ledger kopyasını, parmak izini, manifest'i,
küçük durum arşivini ve şifreli yetki anahtarını içerir. Proje ve genel yapılandırma katmanları
ayrı arşivlenir. Worker klonları, provider oturumları ve secret-store kimlik bilgileri dışarıda
kalır. Set dosyaları 0700 dizinde 0600'dür; sette `ledger.db-wal/-shm` kalmaz.
Değiştirilmiş bir setin SHA değerlerini yeniden yazmak yeterli değildir; verify şifreli
zarfın doğrulamasını da yapar; bu yüzden `BACKUP_PASSPHRASE_INVALID` yanlış parola ya da
değiştirilmiş set demektir.
Şifre çözmeden önce verify ve restore diğer nedenleri kendi kodlarıyla söyler (çıkış 78):
`BACKUP_SET_NOT_FOUND` (yolda `MANIFEST.sha256` içeren klasör yok), `BACKUP_SET_UNREADABLE`
(bu kullanıcı seti okuyamıyor), `BACKUP_PASSPHRASE_REQUIRED` (boş parola) ve
`BACKUP_MANIFEST_INVALID` (bir dosya manifestle eşleşmiyor: set değiştirilmiş). Var olmayan bir setin restore'u, setin yanında
tutulan kurtarma denetimi yazılmadan reddedilir; yanlış yazılmış bir yolda denetim klasörü oluşmaz.

Önce hedef servisi durdurun. Boş hedef doğrudan kullanılabilir; dolu hedef için
`--confirm-target /tam/mutlak/hedef` ekleyin. Başka kurulum kimliğine bağlı hedef reddedilir.
Mevcut kurulumda restore komutunu o kurulumun proje kökünden çalıştırın; başka bir hedefin
yapılandırılmış yerleşimi uyumsuzsa ret verilir. Eski durum `.damaged-<uuid>` kopyalarında korunur. Taşınan kimlik açıkça raporlanır,
installationId korunur; `deckent init identity --keep` operatörün açık onayını ister.
Kurulum içindeki config yolları taşınır; dış yollar korunur. Restore zamanlamayı off yapar.
Servisi açmadan dışarıda kalan kimlik bilgilerini yeniden sağlayın.
Proje katmanı proje yapılandırması olur. Genel yapılandırma (`$DECKENT_GLOBAL_HOME/config.json`)
kurulumlarınızca paylaşılır: restore yalnız onda olmayan arşiv bölümlerini ekler (ör. makine
kaybından sonra `secrets` depo seçimi), var olanları korur (sonuçta `globalConfig.added` / `kept`).
Korunan genel katman başka bir onay anahtarı dosyası gösteriyorsa geri yüklenen proje yapılandırması
setin anahtarını gösterir (`changedPaths` içinde `/approvals/keyFile`); genel dosyanız değişmez.
Korunan bir genel bölüm geri yüklenen proje yapılandırmasıyla kullanılamıyorsa restore hiçbir iş
yapmadan dosyayı ve bölümü adıyla `BACKUP_TARGET_CONFIG_CONFLICT` ile durur: o bölümü uyumlu hâle
getirin veya kaldırın, sonra yeniden çalıştırın.
alpha.18 ile alınmış set tek birleşik belge taşır; onun `secrets` seçimi proje yapılandırmasına
değil genel katmana gider.
Restore var olan bir dizine yalnız sizinse ve başkaları yazamıyorsa yazar (0755 `.deckent`
uygundur; `doctor` modunu yine gösterir). Aksi halde hiçbir iş yapmadan dizini adıyla
`BACKUP_DIRECTORY_UNSAFE` ile durur: `chmod 700 <yol>` çalıştırıp yeniden deneyin. Hasarlı policy
dosyası restore'u `BACKUP_POLICY_UNREADABLE` ile durdurur: adı verilen dosyayı kenara taşıyın
(`mv <yol> <yol>.damaged`) ve yeniden çalıştırın; restore o zaman setin doğrulanmış policy'sini kullanır.
Aynı projeye restore mevcut kaynak yerleşimini korur: her kaynak güncel yapılandırmanın
gösterdiği yere yayınlanır ve geri yüklenen yapılandırma aynı yerleşimi gösterir.
İlk değiştirmeden önce restore hedefte `.deckent/restore-hold.json` bekletmesini yazar; yalnız
sonuncusundan sonra kaldırılır. Bu dosya varken servis başlatma ve proje yapılandırmasını yükleyen
her komut `BACKUP_RESTORE_HOLD` ile reddedilir. `BACKUP_RESTORE_INCOMPLETE` (veya süreç kaybı)
halinde ara dizini (`.deckent/.backup-restore-<uuid>`, özel, yetki anahtarı içermez), eski
kopyaları ve dış audit kayıtlarını teşhis için koruyun, sonra aynı restore'u `--confirm-target`
ile yeniden çalıştırın; setteki policy yalnız bekletme varken kullanılır. Kaynakların tamamı tek
atomik işlemle yayınlanmaz. Başarılı restore önceki yarım ara dizinleri (proje kökündeki alpha.18
`.backup-restore-<uuid>` dahil) siler; kalanları `doctor` listeler.

Etkileşimli config seçicisinden `backup.schedule` için off, daily veya before-upgrade;
`backup.retention` için 3, 7, 14 veya 30 seçin. Daily servis açıkken çalışır;
before-upgrade ledger migration öncesinde çalışır. `BACKUP_PASSPHRASE` değerini seçili
secret store'a mevcut `secret set` maskeli/stdin akışıyla sağlayın. Varsayılan environment
backend için değer servis başlatıcısından sağlanmalıdır. Parola yoksa before-upgrade
migration engellenir. Yalnız doğrulanmış zamanlanmış setlere saklama sınırı uygulanır;
başka adlı operatör dosyaları korunur. Artık doğrulanamayan bir set (ör. parola değişince)
bildirilir ve korunur; sonraki günlük yedeği engellemez, yükseltme öncesinde ise göçü durdurur. Servis kapanışı devam eden yedeklemeyi bekler.

Audit kayıtları parolasız olarak principal, scope ve policy taşır. Create/verify kayıtları
`audit/backup-operations`, restore kayıtları setin yanındaki `.deckent-backup-audit`
altındadır; ledger'ın değiştirilmesi restore niyetini silemez. Güvenilir yetki kurulmadan
önceki ret mühürlenemez ve depolama etkisi üretmez. Linux kernel kilidi doğrulanmıştır;
desteklenmeyen platformda restore reddedilir. KMS, bağımsız inceleme, paket kabulü ve
owner DOGFOOD kararı ayrı kapılardır.

## Yönetim komutları insan diliyle (alpha.48, owner CLI incelemesi 2026-10-19)

Eylemsiz `deckent pool`, `audit`, `secret`, `runtime`, `backup` ve `toolchains` okur: havuzun durumu ve kapasitesi, son checkpoint ile
audit sonucu, anahtarlar (ad · kullanan · depo, değer asla), servis durumu (derleme, yapılandırma, çalışan işler, soket; başlangıç
zamanı bir sonraki protokol sürümüne kadar yok), kurtarma setleri (`state/backups/recovery`: tarih · boyut · tür · son doğrulama ·
ad) ve araç tablosu (ağ kullanımı önce yazılır). `deckent paths` yerleşimi var/yok bilgisiyle gruplar ve gerçekte kullanılan soketi
(`/tmp/dk-<uid>-<sha256>/s`) adlandırır. Boru hattında çıktı metindir; JSON yalnız `--json` ile, aynı sözleşmelerle.
Değişiklik sessiz kapsam almaz: terminal dışında `pool hold|resume|set-capacity|quota-release`, `secret set|delete|store --to` ve
`backup create|restore` `--scope` ister; kimliksiz `runtime shutdown` `--reason` ister. Kişinin terminalinde kapsam, set, anahtar ya da
depo seçilir ve değişiklik önce kartta onaylanır (AI, CI ya da boru hattına asla sorulmaz): daha zayıf gizli depo için ikinci bir uyarı
kartı gerekir, geri yükleme hedefi, servis durumunu ve değiştirilen dosyaların nerede saklandığını gösterir, `toolchains update`
derlemeden önce planı gösterir, `audit rebaseline` kartla onaylanır. `secret set` anahtarı yalnız kişinin terminalinde (gizli istem)
alır: boru, script, ajan ya da CI'dan stdin okunmadan reddedilir (`SECRET_SET_TERMINAL_REQUIRED`).

## Sağlayıcı anahtarları, modeller ve harcama

Anahtarlar: `deckent secret set AD` (gizli istem ya da stdin) anahtarı `secrets.store` ile seçilen depoya yazar
(`core.secret-store.env@1`, `core.secret-store.file@1`, `core.secret-store.encrypted-file@1`); `deckent secret store`
tüm anahtarları kayıtlı başka bir depoya kopyalar, doğrular, seçimi yayımlar ve eski kopyayı siler (daha zayıf depoya
geçiş onay ister; set, delete ve geçiş tek kurulum geneli muhafaza bölümünü paylaşır). Worker'lar anahtar almaz.
`deckent doctor` etkin depoyu adlandırır ve depo listesi başarısız olursa `unverified` gösterir.

Modeller: `deckent models connect --scope <id> --connection <tür> --command-id <id> (--model <id> | --reference <ref>)`
modeli türün paketli kataloğundan bildirir, kapsamın çağrı profilini anahtar adıyla yazar ve etkinleştirir (türler:
anthropic-api, openai-api, deepseek-api, zai-api, zai-cn-api, openai-compatible, local-openai). Doğrulanmış yayımlanmış
tarifesi olmayan uzak model reddedilir ve nedeniyle kilitli görünür. `terminal.defaultModel` (kullanıcı katmanı)
terminalin varsayılanıdır; `/model` oturum sabitlemesi önce gelir, sonra projede yazılmış referans.

Kişi için (C-MODELS, owner CLI incelemesi 2026-10-19): argümansız `deckent models`, scope'un worker kataloğunu tek tabloda gösterir
(model, kanal, durum, effort; emekli model günüyle; `models.retirementWarningDays` içinde, varsayılan 15, emekli olacak açık model için
uyarı); `--declared` bağlı sağlayıcıların beyanını (sohbet kataloğu) listeler ve o listenin JSON biçimidir (`models --declared --json`);
`models --json` katalog incelemesidir. Terminalde uzun bayrakları olmadan `models activate|deactivate`, `models catalog activate|deactivate`
ve `models connect` scope'u, sağlayıcıyı ya da kanalı ve tam model kimliğini (takma ad asla) sorar, bağ özetini ve revizyonları kendisi
okur ve scope'lu kartla onaylatır; yapay zekâ araçları için uzun biçimler değişmedi. `--input` olmadan `models spending` scope'un API
bütçesini (sınır, kullanılan, ayrılan, kalan) gösterir.

MCP ve kimlik: `deckent mcp` / `mcp list` bir tablodur (bekleyenler önce, sonraki adımlarıyla) ve hiçbir şeyi başlatmaz; `--check`
yalnız güvenilir sunucuları başlatır. Her güven kararı (`mcp approve`, yerel ya da kullanıcı kapsamına `mcp add`) bir kişinin
terminalindeki karttır; terminal dışında reddedilir (`MCP_APPROVAL_NEEDS_TERMINAL`) ve `--yes` artık kartı atlamaz (owner A48-D5/D6).
Argümansız `deckent identity` (katalog deltası bekliyor: o zamana dek `identity profiles`) seçili profili — ya da
`deckent config set identity.profile` ile nasıl seçileceğini —, kişileri ve rol bağlamalarını söyler; profil seçilmemişken
`identity preview` `IDENTITY_PROFILE_NOT_SELECTED` bildirir; terminalde `identity distribute --scope <id> [--apply]` ok tuşlu kartlarla
ve önizleme kartıyla seçilir.

Harcama: ücretli çağrılar uygulanabilir en pahalı yayımlanmış kademeyi rezerve eder ve sağlayıcının döndürdüğü kullanım ile
sabitlenmiş tarifenin çarpımından kesinleşir (`measured-tariff`). Kapsamın ilk bütçesi `deckent models create-budget
--scope <id> --usd <n>` (ya da bütçe penceresi: `/provider`'ın ilk satırı) ile açılır, `revise-budget [--unfreeze]` ile değişir; son kullanımı
hiç gelmemiş askıdaki çağrı `reconcile-spending` ile çözülür. Ayrıntı: ARCHITECTURE "Spend settlement".

### Teslim onayı (TESLIM-GUVENLIK yazar adayı)

`task integration-deliver`, `task integration-adopt` ve `task integration-rollback`, doğrulanmış insan terminalinde tek açık `y` ister (geri alma, dala alınmış dalı geri taşır; bu yüzden dala alma gibi sorar, kartı dalı ve şimdiki → önceki commit'i gösterir). Kart görev başlığını, Run/Task kimliklerini, referans/dalı, önceki/yeni commit'i ve değişen dosyaları gösterir. Boş yanıt, `n`, EOF, yönlendirilmiş giriş/çıkış ve SDK/MCP yeni etkisi reddedilir. Prepare/check yalnız adaydır. Tamamlanmış replay ve kanıtlanmış yayın sonrası çökme uzlaştırması tekrar sormaz; bitmemiş etki yeni onay ister. Benimsemede `execution.adoption.targets`, politika, kabul ve yapılandırılmış doğrulama koşulları korunur; `execution.adoption.verification` yapılandırılmışken terminal teslim penceresi, yapılandırılmış türde kabul edilmiş bir doğrulama Run'ını kişiye seçtirir (aşağıda); bir ret nedenini gösterir ve tam `task integration-adopt … --verification-run <run>` komutunu komut satırı seçeneği olarak korur. Otonom politika etkin değildir. Bilinen sınır: doğrulanmış terminal tanığı yalnız Linux'ta (WSL dahil) var; diğer sistemlerde teslim, dala alma ve geri alma `DELIVERY_INTERACTIVE_REQUIRED` ile reddedilir.

Teslim commit'i kabul edilmiş görev başlığı, kimlikler ve sınırlı kabul durumu taşır; yazar/committer zamanı trusted clock'tan ilk teslim planında alınır, intent replay için dondurur. Varsayılan kimlik Deckent; `execution.git.deliveryIdentity` ile `authorName`/`authorEmail` ayarlanabilir. Yanıttan önce Git nesneleri yalnız adayda hazırlanır; ret halinde asıl depoda nesne/ref/dal veya teslim intent'i yazılmaz.

### Terminalde Run denetimleri (Y1 yazar adayı)

`/runs` kapsamın Run'larını seçimli listeler. Terminalde yaşam döngüsü işleyicisi (CLI'nin süreç içi `run hold|resume|close` uygulaması) varsa `h` bitmemiş, iptal edilmeyen ve zaten bekletilmeyen bir Run'ı bekletir, `r` operatör bekletmesi ya da başarısız ilerleme ile park edilmiş bir Run'ı sürdürür (soru, karar ya da kota beklemesi sürdürmeyle kalkmaz; orada `r` sunulmaz), `c` bekleyen bir Run'ı kapatır; ipucu satırı yalnız seçili Run'ın gözlenen durumunun sunduğu tuşları adlandırır. Her tuş Run'ı yeniden okur ve denetimin ne yaptığını, durumu ve gönderilecek revizyonu gösteren bir y/N kartı açar; yalnız tek yazılmış `y` gönderir (Ctrl/Alt bileşimleri, yapıştırılmış ya da birleşmiş tuşlar asla; `n`, Enter, Esc ve Ctrl+C Run'ı korur). Bekletme kişinin gerekçesini (Tab) ya da varsayılan bir cümleyi not olarak alır. Komut, gösterilen revizyona karşı CLI'nin kendi yaşam döngüsü komutudur; politika (bekletme/kapatma için `run cancel`, sürdürme için `run reserve`) ve Run'ın durumu karar verir, ret listenin üstünde oturum dilinde tipli neden olarak görünür. Sonuç satırı Run'ın sonraki durumunu ve komut kimliğini adlandırır. Bekletme yeni rezervasyonları durdurur; zaten çalışan iş sürer. Girdi bekleyen bir göreve yanıt ve görev kabul/ret ayrı kararlardır, buradaki tuşlar değildir.

### Terminalde teslim penceresi (TESLIM-PENCERESI yazar adayı)

Bu terminalin `/do` ile kabul ettiği bir Run'ın görevi "kabul edildi · yama hazır, teslim bekliyor" durumuna gelince teslim penceresi kendiliğinden, girişin odağını almadan açılır (Ctrl+O ya da Aktif iş şeridindeki "teslim bekliyor" satırı Ctrl+T ve Enter ile odağı ona verir); `/deliver` kapsamdaki bekleyen tüm görevleri listeler ve seçileni odakla açar. Pencere görev başlığını, Run/Görev kimliklerini, güncel kaynağın uyum kontrolünü (etkilenen dosyalar tabanla aynı), değişen dosyaları `patch-preview --stat` sayılarıyla, yalnız ayrı bir `refs/deckent/deliveries/` referansının yazılacağını (dallar, index ve çalışma ağacı değişmez) ve yalnız `execution.adoption.targets` yapılandırılmışsa hedef dalları sonraki ayrı bir seçim olarak gösterir. `y`, `task integration-check|prepare|deliver` ile aynı uygulamalar ve yukarıdaki doğrulanmış terminal onayı üzerinden kontrol, hazırlık ve teslimi tek akışta yapar: pencerenin `y`'si onayı yalnız kart pencerenin gösterdiği işlem, kimlikler, komut, dosya kümesi ve tabanla birebir aynıysa cevaplar; değilse kartın kendisi gösterilir ve yeni bir `y` ister. Teslimden sonra yapılandırılmış dala alma yalnız ikinci bir `y` ile yapılır (↑↓ dalı seçer); `n`/Esc hiçbir şey yapmaz. `execution.adoption.verification` yapılandırılmışsa (Y1) bu `y` önce doğrulama adımını açar: kapsamın yapılandırılmış türde (tek görevli) kabul edilmiş Run'ları, yalnız zorunlu değilse "doğrulamasız dala al" satırı; ↑↓ seçer, tek yazılmış `y` seçimle dala alır (tür o anda yapılandırmadan okunur, `task integration-adopt --verification-run` gibi), `r` listeyi yeniden okur, `n`/Esc geri döner. Hiç yoksa bunu söyler ve `deckent run create … --delivery-command-id <bu teslim>` adımını adlandırır. Dala alma uygulaması Run'ın tam olarak bu commit'i güncel profil ve kurulum ölçütleriyle doğruladığını yine denetler; bir ret, nedeniyle ve yeni bir dala alma komutuyla seçime döner. Teslim ve dala alma satırları ile döküm özeti teslim ve dala alma komut kimliklerini gösterir (`task integration-rollback --adoption-command-id`). Girişe yazılan `y` hiçbir zaman onay değildir. Eskimiş taban, eksik izin (attempt araması için `scope inspect` ve entegrasyon eylemleri) veya doğrulanmamış oturum sade sözlerle ve sonraki adımla reddedilir. Teslim kendiliğinden başlamaz; ileride owner'ın koyacağı "kurala göre otonom" aracı aynı onay portuna bağlanır ve uygulanmadı. Hazır adım ayrıca her değişen dosyanın salt okunur farkını sunar (alpha.46; yeni komut yok): ↑↓/j/k dosya seçer, Enter hunk'ları önizlemenin kurulduğu deneme, taban ve öneri kimliğiyle açar, ↑↓/j/k kaydırır, Esc listeye döndürür. Port, sayıların geldiği aynı yamadan dosya başına fark gövdesi taşır; sınırlar `deliver-port.json` içindedir (`maxDiffFiles`, `maxDiffLinesPerFile`, `maxDiffBytesPerFile`); ikili ya da aşırı büyük dosya gövde yerine "Gösterilemez: ikili veya çok büyük" der, kesilen satırlar sayılır. Her satır pencerenin geri kalanıyla aynı redaksiyon ve terminal metni temizliğinden geçer. Görmek hazırlamaz, teslim etmez, dala almaz: fark içinde `y`, `n` ve Enter bir şey yapmaz; teslim, liste adımındaki ayrı doğrulanmış-terminal `y`'si olarak kalır. Eski taban ya da reddedilen erişim yine tipli ret satırıdır.

### CLI'dan onaylar ve kararlar (C-APPROVE yazar adayı)

`deckent approval list` (katalog `list` okumasını tanıyınca argümansız `deckent approval` da) varsayılan scope'u okur (ilk satırda adı yazar; `--scope` değiştirir): önce kalan süreyle bekleyen onaylar ("8 dk kaldı"), sonra diğerleri yeniden eskiye; en çok `approval.json` sayfa ve satır sınırı kadar, sessiz kesme yerine "daha fazla"/"taranmadı" satırları; `--json` ham sayfadır. Kişinin terminalinde ardından bekleyen bir onay seçilip terminalin kartında yanıtlanır: bir kez / hayır (saklanan bir onayın çalışan turu yoktur, terminal de ona "bu oturum"/"her zaman" sunmaz; sert taban isteği yalnız bir kez izin verilebileceğini söyler). Revizyon ve komut kimliği sistemden gelir, kanal `local-cli`, gerekçe kişinin `--reason` değeri ya da varsayılan "Terminalde onaylandı"dır; iptal edilen ya da sessiz kalan kart karar vermez ve karar önceki gibi aynı runtime `decideApproval` (doğrulanmış terminal, güvence alt sınırı) üzerinden gider. `--input` olmadan `approval decide` terminalde aynı seçimdir, başka her yerde eksik `--input` adını söyler. JSON yolu (`--input`) AI araçları için değişmedi; girdi önce uygulamanın şemasıyla denetlenir, yanlış alan adıyla söylenir (`CLI_INPUT_FIELD_INVALID`, çıkış 2, örnekle) — `INVENTORY_QUERY_INVALID` yerine —, gerekçesiz karar hiçbir şey gönderilmeden reddedilir, sonuçlar okunur metindir, ham JSON yalnız `--json` ile; `--schema` girdi sözleşmesini basar. Eylemsiz `deckent decide` scope'un son kararlarını listeler (karar portunun `inspect` izni; ilk kurulum v12 politikasında yoktur, v13 şablonuna kadar `POLICY_DENIED`); terminalde bir karar seçenekleri, tavsiye, seçim ve sonuçla tek pencerede açılır. `decide <eylem> --schema` ve alan adlı girdi hataları `approval` gibi çalışır. MCP'de hâlâ karar aracı yoktur.

## Kaynak derleme ve sandbox durumu

README'den taşındı (alpha.53 yeniden yazımı); README kısa kurulum yolunu tutar.

- Yeni bir kaynak derlemesi, kilitli bubblewrap'ı (şu an 0.13.0) derleyip yerleştirmek için Docker ister; kilitli kaynağı
  indirir, kaynak ve binary özetlerini doğrular. Doğrulanmış, yerleştirilmiş paket çevrimdışı yeniden kullanılabilir. Sistem
  bubblewrap'ı seçilirse sürümü en az 0.12.0 olmalıdır. Native yalıtım yardımcısı için C derleme araçları gerekir.
- Her `build-bwrap` çalıştırması için yeni bir `--out` dizini kullanın. Build `bubblewrap=present` ya da
  `bubblewrap=staged from …` ile biter. Linux'ta kilitli bubblewrap yerleştirilemezse build bitmez, `BUBBLEWRAP_BUILD_REQUIRED`
  ile durur; Docker'ı başlatıp yeniden çalıştırın ya da `DECKENT_BWRAP_BUILD=<doğrulanmış build-bwrap çıktısı> npm run build`
  kullanın. Yalnız Linux dışında `bubblewrap=absent (not Linux)` basar; bu, bubblewrap sandbox'ı olmadığı demektir. Yalıtım
  durumunu `deckent doctor` ile inceleyin.
- Hiçbir servis çalışmadan yapılan ilk `doctor` bubblewrap yerine Landlock gösterebilir (`doctor --verbose` nedenini söyler):
  `doctor` yalnız ölçer; paketlenmiş bubblewrap'ı `.deckent/bin` altına runtime servisi, ana makineyi ölçerken yerleştirir.
  Servisi başlatın (`deckent`) ve `doctor`'ı yeniden çalıştırın.
- **Ubuntu 24.04 ve sonrası.** Çekirdek, bubblewrap'ın ihtiyaç duyduğu ayrıcalıksız kullanıcı ad alanlarını kısıtlayabilir.
  `sysctl kernel.apparmor_restrict_unprivileged_userns` ile bakın: `1` kısıtlı demektir; WSL'de anahtar yoksa (`cannot stat`)
  kısıt yoktur. Deckent o zaman kısıtı bildirir, görünür biçimde Landlock'a düşer ve tam erişimli kabuk çağrılarını reddeder,
  çünkü onlar açık bubblewrap sandbox'ı ister. Bir yönetici bubblewrap'ı root sahipli `/usr/local/bin/bwrap` olarak, ona
  `userns` izni veren bir AppArmor profiliyle kurabilir.
- `npm link`'ten sonra Deckent kaynak dizininin dışındaki kendi proje klasörünüzde çalışın. Uzun ve boşluklu yollar çalışır:
  yerel soket, kuruluma özel kısa ve özel bir dizin kullanır. `deckent init preview --profile <dosya>` bir kurulum profili
  dosyasını önizler (ileri düzey).

## Sağlayıcı bağlantı ayrıntıları

- `deckent init policy --scope <id> --apply` ilk kurulum politikasını kurar, varsayılan terminal kapsamını
  (`terminal.scopeId`) ve sohbet sınırlarını yazar, iptal ayarlarını ve göçü tamamlanmış boş ledger'ı oluşturur. Linux, WSL ve
  macOS'ta yeni kurulum şifreli anahtar deposuyla başlar. Sonraki komutlarda aynı kapsam kimliğini kullanın; mevcut kurulumda
  ayarlarda tanımlı kapsam kimliği geçerlidir.
- `/provider` şunları sunar: Anthropic API, OpenAI API, DeepSeek API, Z.ai GLM, Zhipu GLM Çin, OpenRouter, vLLM, Ollama ya da
  LM Studio gibi yerel bir sunucu ve fiyatı yayımlanmış OpenAI uyumlu bir uç nokta. Ücretsiz denemenin reddettiği anahtar asla
  saklanmaz. Ücretsiz denemesi olmayan sağlayıcıda anahtar doğrulanmadan saklanır; olası reddi ilk tur gösterir.
- **Model bağla:** paketlenmiş kataloğu olan sağlayıcılar o modelleri sunar; kataloğu olmayanlarda önce adresi, sonra sınırlı
  `/v1/models` listesinden birebir model kimliğini seçersiniz. Deckent bu kimliği aynen saklar. Yerel loopback modeller
  ücretsiz ölçülür; yayımlanmış fiyatı doğrulanmamış uzak model listelenir ama nedeni ve sonraki adımıyla kilitli kalır (Zhipu
  GLM Çin, fiyatları CNY olduğu için kilitli kalır). OpenRouter model bağlantıları sunar; ücretli çağrı için fiyat ve
  yönlendirme yine doğrulanmalıdır.
- **Bağlantı türüne göre gizli adlar:** `DECKENT_ANTHROPIC_KEY`, `DECKENT_OPENAI_KEY`, `DECKENT_DEEPSEEK_KEY`,
  `DECKENT_GLM_KEY`, `DECKENT_GLM_CN_KEY` ya da `DECKENT_OPENROUTER_KEY` (`/provider` aynı adla saklar). Yerel sunucu isteğe
  bağlı `DECKENT_LOCAL_ENDPOINT_KEY` adını, OpenAI uyumlu uç nokta ise host'undan türetilen `DECKENT_OAICOMPAT_<HOST>` adını
  kullanır. `--model` birebir API model kimliğini alır; paketlenmiş kataloglar kaynak dizinindeki
  `assets/model-catalog/<bağlantı>.json` dosyalarındadır, terminalde `/model` listeler.
- **Kasalar:** `secret set --main` kurulum kasasına, `--project` projenin kendi kasasına yazar (adlar yalnız referans tutan
  `.deck` dosyasında). Ana kasa anahtarı bir projede ancak izinle kullanılır: solo kurulumda terminal sohbeti bir kez sorar ya
  da `deckent secret grant AD --scope <id>` çalıştırın; `deckent secret list --all` her kasayı gösterir.
- **Model seçimi:** `/model`, kullanılamayan modeli nedeniyle kilitler (bütçe yok, bağlı değil, anahtar eksik, etkin değil).
  **Yalnız bu oturum** modeli oturuma sabitler; **Bu oturum ve varsayılanım olsun** ayrıca `terminal.defaultModel` yazar. Proje
  kendi modelini belirtiyorsa pencere kullanılan modeli hangi ayarın seçtiğini söyler.
- **Bütçe penceresi:** 5, 10, 25, 50 ya da 100 USD veya ok tuşlarıyla 1 ile 1000 arasında başka bir tam dolar tutarı, ardından
  bir onay adımı; sonra `/provider`'ın ilk satırı **Bütçeyi değiştir** olur. Yerel loopback modeller ve abonelik modelleri
  bütçesiz çalışır. Sağlayıcı bildirmediyse `/usage` akıl yürütme token'larını *ölçülmedi* gösterir; harcama hesabını (üst
  sınır, ayrılan, kesinleşen) okumak için orada bir bütçe açın.
- **Bugün abonelikler:** Claude Code işçisi kendi Claude girişinizle çalışır; abonelikli Brain hazırlanıyor (henüz yok); Claude
  aboneliğiyle terminal sohbeti şu an desteklenmiyor, sohbet için Anthropic API anahtarı kullanın. ChatGPT ile giriş
  `/provider`'da henüz kullanılamıyor olarak görünür.
- **İstem önbelleği:** yeni Anthropic profilleri 5 dakikalık istem önbelleğini kullanır, mevcut profiller yalnız sizin
  seçiminizle değişir; `/usage` canlı hesabı USD olarak, önbellek okuma ve yazmalarını ve tahmini net kazancı gösterir.

## Adım adım ilk iş kurulumu

- **Başlamadan önce:** kurulumunuzda güncel ilk kurulum politikası olmalıdır. Yeni bir
  `deckent init policy --scope <id> --apply` bunu kurar; eski kurulum `deckent init policy --scope <id> --upgrade --preview`,
  ardından önizlemenin bastığı değerle `--apply --expect <değer>` ile yükseltilir. Değer politika revizyonunu ve runtime servis
  kimliğini bağlar; arada biri değişirse uygulama reddedilir ve yeni önizleme ister. `--modes none` tam otomatik/tam erişim
  iznini kaldırır (bir sonraki çağrıda kip artık geçerli olmaz; kayıtlı seçim kalır ve terminal verilmediğini söyler).
- **İşçi imajı:** `npm run worker:image -- <yeni makbuz yolu>` Deckent kaynak dizininde çalışır, Docker ister ve yeni bir
  makbuz dosyası yazar. Değişmez imaj kimliğiyle tek satır JSON basar, örneğin
  `{"imageId":"sha256:f296…5250","tag":"deckent/worker:r4-20260930","imageVersion":"r4-20260930","receipt":"…","activation":"not-activated"}`.
  Hiçbir şey etkinleştirilmez; imajı `execution` ayarı adlandırır.
- **`execution` değerleri:** README örneği canlı kurulumun sınırlarını kullanır (2 GiB bellek, 512 süreç, 1 CPU, 20 dakikalık
  süre, sınırlı log ve çıktı). Kaydetme şunu basar:
  `execution, proje katmanına kaydedildi. Uygulama: yeniden. Yedek: …/.deckent/config.json.bak.<zaman>.…` ve
  `Yeniden başlatma gerekli: çalışan servis önceki yapılandırmayla başladı. `deckent runtime restart` ile (terminalde /service-restart) yeniden başlatın.`
- **Kayıt ve havuz:** `deckent init registry`, bulduğu kodlama CLI'ından ilk kabul kaydını (registry) ve havuz ayarlarını
  yazar. Önizleme CLI'ın tam sürümünü geçici ve ağsız bir container'da ölçer, önerilen sürümlü profili ve görev türünü
  gösterir, hiçbir şey yazmaz; apply ölçümü tekrarlar ve config policy, revizyon kontrolü ve denetim üzerinden yazar. Var olan
  bir kaydın üzerine asla yazılmaz (tipli ret); başka bir tür eklemek için
  `deckent coding template --provider <id> --kind <tür> --preview|--apply` kullanın. Sonucu `deckent config explain admission`
  gösterir. `--discovery` verilmezse işçi depo talimat dosyaları gizli çalışır (`disabled`); bunları gizlemenin doğrulanmış
  yolu olmayan bir CLI `--discovery repository` ister. İşçiler proje talimat özetini ancak kendi terminalinizde
  `deckent coding instructions trust --scope <id>` onayından sonra görür.
- **Yeniden başlatma:** `deckent runtime restart` şunu söyler: `Runtime servisi yeniden başlatıldı (pid …, örnek …).` Yeni bir
  `init policy --apply` (ilk kurulum politikası v12 ve sonrası) servisi zaten adlandırır (`service.identity`) ve onu yalnız
  kuran kişinin durdurmasına izin verir. Daha eski bir ilk kurulumda önce yükseltmeyi çalıştırın; servis kimliğini ayarladığını
  söylerse çalışan servisi bir kez elle durdurun ([Runtime servisi](#runtime-servisi)), sonra `runtime restart` çalışır.
- **Plan kartı:** `/do` kartının Risk ve Geri alma satırları "araç sınıflandırmadı" ve "araç bildirmedi" der; kart
  `approvals.requestTtlMs` (10 dakika) sonra sona erer. `y` sonrası: `Run <run-id> kabul edildi. /tasks veya /monitor ile izleyin.`
- **Teslim ve dala alma satırları:** `/deliver` "/deliver · teslim bekleyen görevler" başlığını taşır; yamayı güncel kaynakla
  karşılaştırır ve `Teslim edildi: commit <commit> → refs/deckent/deliveries/<özet>` ile biter. Dala alma
  `<commit> commit'i bir dala alınsın mı? Bu dalı ilerletir ve ayrı bir y ister.` diye sorar ve
  `Dala alındı: refs/heads/deckent/first-job <önce> → <sonra>` ile biter; `main` burada checkout edilmişken sunulmaz.
  Checkout'unuz, index'iniz ve çalışma dosyalarınız değişmez.

## Teslim kuyruğu: inceleme ve geri alma

Kayıtlı entegrasyon hedefi servis kuyruğunu kullanır (1.0.0-alpha.43'ten beri canlıda kullanılıyor; beta kabulü bekliyor).
`/deliver` güncel tabanda hazırlar; taban/hedef reddinden sonra `r` yeniden hazırlama sunar. Son bilinen durumu `r` ile okuyun;
yayın ve benimseme tam ve sabit partiyi ayrı gösterip `y/N` sorar. `/runs` ayrıntısı yetkili kapsam konumunu, sorumluyu ve
sonucu gösterir. Main/varsayılan/korunan, checkout'taki veya yabancı hedef allowlist'te olsa da reddedilir. Çakışan yollar yeni
Attempt gerektirir; kullanıcı dalına rebase/merge yapılmaz.

```sh
deckent task integration-queue-list --scope my-project --json
deckent task integration-queue-inspect --scope my-project --command-id <bilet> --json
deckent task integration-queue-confirm --scope my-project --command-id <bilet>
deckent task integration-queue-rollback --scope my-project --source-command-id <bilet> --command-id undo-1
deckent task integration-queue-confirm --scope my-project --command-id undo-1
```

Geri alma kartı sonuçlanmış tek işi kapsar. Hata partinin kalanını durdurur, benimsenmiş ön ek korunur; belirsiz etki o hedefi
uzlaştırmaya kadar tutar. Eski doğrudan entegrasyon komutları tarihsel makbuzları korur ama etkin kuyruk generation'ı üzerinden
yazamaz. Sınırlar ve bilet ömrü `targetQueue` kaynağındadır; doğrulama profili ve politika gerekir. Kuyruk canlıda gerçek
teslimleri sonuçlandırdı; bu, paketlenmiş binary, hosted CI, platform veya N1 yük kabulünün kanıtı değildir, bunları beta kabulü
göstermelidir. alpha.53'ten beri kuyruk listesi, inceleme, kuyruğa alma ve geri alma görünümleri ile `/deliver` penceresi teslim
özetini değişmeyen onay kartının üstünde gösterir; danışman bir kural (`autonomy@1`) her bilet için `would-deliver` ya da
`would-hold` kaydeder ama hiçbir şey yapmaz ([bilinen sınırlar](../../../docs/known-limits.tr.md)).

```text
Kaynak <kaynak> · etkilenen dosyalar base ile aynı · öneri <öneri>
Aday hazır: <yol>
Commit <commit>, <ref> referansına teslim edildi. Kaynak HEAD, index ve çalışma dosyaları değişmedi.
Benimsendi: <ref>, <önce> → <sonra> taşındı (sıra 1). Dayanak: kayıtlı Task kabulü, doğrulama değil; checkout, index ve çalışma dosyaları değişmedi.
Geri alındı: <ref>, <sonra> → <önce> taşındı (sıra 2). Checkout, index ve çalışma dosyaları değişmedi.
```

## Runtime servisi

- **Başlatma.** `deckent`, çalışan servis yoksa onu arka planda başlatır, varsa onu kullanır. Çıktısı
  `.deckent/state/runtime-service.log` dosyasına gider (veri kökünü taşıdıysanız onun altına). `deckent runtime serve` onu ön
  planda çalıştırır; Ctrl+C durdurur.
- **Boşta durma.** Terminalin başlattığı servis 15 dakika iş almazsa kendiliğinden durur (`service.idleShutdown.afterMs`);
  sonraki `deckent` onu yeniden başlatır. `runtime serve` ile başlattığınız servis kendiliğinden durmaz. `deckent-mcp` servisi
  başlatmaz.
- **Yeniden başlatma ve durdurma.** `deckent runtime restart` servisi yönetilen durdurmayla kapatır, güncel derleme ve
  yapılandırmayla yeniden başlatır; `deckent runtime shutdown` yalnız durdurur. `deckent runtime describe` çalışanı gösterir.
  İkisi de servisin kimliğini (`deckent config explain service.identity`) ve sizin o servis üzerindeki `shutdown` kuralınızı
  ister; ilk kurulum politikası bunu yalnız kuran kişiye verir. Yerel MCP aktörü varsayılan olarak servisi durduramaz (politika
  ona `service` MCP grubunu verirse durdurabilir).
- **Eski kurulumlar.** v12'den eski bir ilk kurulum politikasında ne servis kimliği ne de `shutdown` kuralı vardır; bu yüzden
  `runtime restart` ve `runtime shutdown` reddedilir. `deckent init policy --scope <id> --upgrade --preview`, ardından
  `--apply --expect <değer>` ile yükseltin ([Adım adım ilk iş kurulumu](#adım-adım-ilk-iş-kurulumu)); apply `service.identity`
  ayarlarsa çalışan servisi bir kez elle durdurun (`runtime serve` üzerinde Ctrl+C), sonra `runtime restart` çalışır.

## Sandbox görünümleri

- Standart, dikkatli ve tam otomatik modlarda sandbox'taki kabuk komutu **kapalı bir görünüm** alır: proje, çağrının onay
  kuralları içinde yazılabilir; `.git` salt okunur, ev klasörü gizli ve ağ kapalıdır. Onaylanan komutlar da Deckent'in yetki
  dosyalarına yazamaz. Landlock ayrıca izin ve sahiplik değişikliklerini reddeder ve korunan yolları tutan dizinlerde giriş
  ekleyip silemez.
- Tam erişim, kullanılabilir bir **açık bubblewrap sandbox'ı** ister: ağ ve ev klasörü açılır; Deckent durumu, ayarlar, kimlik
  bilgisi kalıpları ve host Docker/oturum D-Bus soketleri maskeli ya da salt okunur kalır. Açık sandbox yoksa tam erişim kabuk
  çağrıları, açıkça `host` seçilmiş olsa bile reddedilir.
- Kapalı modlarda `prefer-sandbox` görünür bir bildirimle host'a düşebilir; bu yol dosya sistemi sınırı uygulamaz. Yalıtım
  gerekiyorsa `require-sandbox` seçin.
- Ortak kimlik bilgisi kataloğu gh, Docker, kube, Codex, Git kimlik bilgileri ve yaygın bulut CLI'larını kapsar. Ev klasörü
  maskelemesi sınırlıdır (3 derinlik, 20.000 giriş); özel konumlar, farklı dosya adları ve maskelerin dışındaki takma yollar
  ayrıca yalıtılmalıdır.
- Tam otomatik `find -delete`, dosya kısaltma (`>`, `>|`) ve taşıma (`mv`) için yine sorar; ekleme (`>>`) değişiklik sayılır.
- Sabit zemin (Deckent ayarları, policy, onaylar, denetim, sırlar ve MCP kayıt defteri) her sandbox modunda uygulanır.

## Gizli depolar ve katı kurulum

| Depo (`secrets.store`) | Diskte | Anahtarı kim okuyabilir |
|---|---|---|
| `core.secret-store.env@1` (hiçbir depo seçilmemişse) | hiçbir şey; ortam değişkeninden okunur | o ortamı devralan her program |
| `core.secret-store.file@1` | düz metin, 0600 dosya | Deckent ve sizin hesabınızla çalışan diğer programlar |
| `core.secret-store.encrypted-file@1` (önerilen; yeni kurulumlar bununla başlar) | şifreli (AES-256-GCM); açma anahtarı aynı klasörde, parola yok | Deckent; sizin hesabınızla çalışan diğer programlar yine açabilir |

Sağlayıcı çağrıları anahtarı çalışma zamanının içinde çözer; anahtar isteme veya shell ortamına konmaz. Desteklenen sandbox
görünümleri depoyu gizler; host'a düşen yol ya da host realm dosya sistemi yalıtımı sağlamaz. Saklı anahtarı geri yansıtan
sağlayıcı yanıtı reddedilir. `deckent doctor` hangi deponun etkin olduğunu, `deckent doctor --verbose` kimin okuyabileceğini de
gösterir. Sağlayıcı anahtarı reddederse (401/403) ya da bir limit dolarsa terminal bunu açık sözlerle söyler.

**Katı kurulum**, anahtarı makinedeki başka hiçbir programın okumaması gerekiyorsa. Yeni Linux/WSL/macOS kurulumları, kurulu
politika geçişe izin veriyorsa şifreli depoyu `init policy --apply` ve Docker `init apply` ile seçer; mevcut kurulumlar
seçimlerini korur.

1. Anahtarlarınızı şifreli depoya taşıyın: `deckent secret store` kayıtlı depoları seçmeniz için listeler; env deposundan
   çıkarken hedefte eksik olan yapılandırma başvuru adlarını listeler ve evet/hayır sorar (betikler `--confirm-env-missing`
   ister); `doctor` aynı adları gösterir. Komut her anahtarı kopyalar, doğrular, yeni depoyu seçer ve ardından eski kopyayı
   siler (daha zayıf bir depoya geçiş önce sorar).
2. Diğer yapay zekâ araçlarını Deckent'in durum klasöründen uzak tutun; örneğin Claude Code'un `~/.claude/settings.json`
   dosyasında depo dosyaları için `Read` yasak kuralları. Bu, dosya araçlarını ve yaygın shell komutlarını durdurur, her betiği
   değil.
3. Planlanan: Deckent servisini ayrı bir işletim sistemi kullanıcısında (ya da macOS Keychain ile) çalıştırmak; böylece
   hesabınızdaki hiçbir program anahtarları okuyamaz.

Dosya depoları native Windows'ta henüz yok.

## Harcamanın kesinleşmesi

Her kapsamın tüm API sağlayıcıları için ortak tek bir USD bütçesi vardır. Ücretli bir çağrıdan önce Deckent, geçerli olabilecek
en pahalı fiyat kademesinde çağrının tutabileceği en yüksek tutarı ayırır; sonra çağrıyı sağlayıcının son yanıtında bildirdiği
kullanım ile doğrulanmış yayımlanmış fiyatın çarpımından kesinleştirir. OpenRouter çağrıları istisnadır: OpenRouter'ın yanıtında
bildirdiği ücretten kesinleşir. Sağlayıcı hangi fiyat kademesini kullandığını söylemiyorsa (DeepSeek) çağrı yayımlanmış en
yüksek fiyattan kesinleşir ve üst sınır olarak işaretlenir. İlk ücretli OpenRouter çağrısından önce
https://openrouter.ai/settings/plugins sayfasında hiçbir eklentinin "Prevent overrides" ile açık olmadığını kontrol edin ve
OpenRouter kredi sınırını Deckent bütçenizden yüksek olmayacak şekilde ayarlayın; Deckent bu iki ayarı göremez. Komutlar:
`deckent models create-budget|revise-budget [--unfreeze]` ve `deckent models reconcile-spending`.

## Dağıtım uzantı girişi

Public uzantı girişi, bir CLI dağıtımının etki adaptörleri, gizli depo adaptörleri ve sır yardımcıları, onay güvencesi
üreticileri, MCP yetki grupları ve sağlayıcı ücretsiz-çağrı sertifikaları kaydetmesini sağlar. alpha.20'den beri aynı dağıtım
kayıtlarıyla servis ve MCP girişini de başlatabilir; otomatik servis başlatma ve yeniden başlatma dağıtımın girişini yeniden
çalıştırır (elle çalıştırılan `npm run smoke:dist` ile sınanır, CI'da yok). Core'un yalın çalıştırılabilir dosyaları bu
modülleri kendiliğinden keşfetmez.

## MCP izin grupları

`/policy` (**MCP izinleri**) penceresinde havuz yönetimi, katalog kaydı ve genel model yapılandırması **tüm kapsamlar** olarak
gösterilir. Bir grubun iznini kaldırmak başka izinleri silmez; araç o izinlerle açık kalabilir. "Dogfood çalışanı" yalnız iş
yetkilerini içeren bir öneridir; kesin N1 MCP kullanımı doğrulanmadı. Kaldırma, verme ile aynı iki adımı kullanır
(`deckent policy mcp revoke … --preview`, sonra `--apply --expect <özet>`).

## Gündelik komutların ayrıntısı

- `deckent run hold|resume|close` ve `deckent pool hold|resume` işi durdurur, sürdürür ya da kapatır; `deckent identity profiles`
  kimlik profillerini gösterir; `deckent init` önizlemeden sonra proje talimatlarını (`DECKENT.md`) hazırlar.
- `deckent backup create|verify|restore` doğrulanabilir kurtarma setleri yazar; isterseniz zamanlanmış ve saklama süreli. Geri
  yükleme yalnız servis durmuşken çalışır. Setin içindeki yalnız yetki anahtarı parolanızla şifrelenir; ledger ve durum arşivi
  düz dosyadır, setleri güvendiğiniz bir depoda saklayın (setin tamamının şifrelenmesi henüz yok). Bkz.
  [Kurulum kurtarma setleri](#kurulum-kurtarma-setleri).
