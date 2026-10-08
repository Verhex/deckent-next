# İşletim başvurusu

[README.tr.md](../../../README.tr.md) içindeki ürün özetinin arkasındaki ayrıntılı işletim davranışı. English: [operator-reference.md](operator-reference.md).

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
hazırlar. `toolchains.update.mode` değerleri `off | propose | auto`, varsayılan `propose`'dur.
Tipli plan `<data root>/workspaces/toolchains/plans/` altına yazılır. `auto` ya da `--apply` ile paketli
builder `workspaces/toolchains/builds/<version>/` altına kopyalanır ve sınırlı sürede derlenir;
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

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

Parola maskeli terminal isteminden veya stdin'den okunur; komut argümanına yazılmaz.
Parolayı setten ayrı saklayın. Set; çevrimiçi ledger kopyasını, parmak izini, manifest'i,
küçük durum arşivini ve şifreli yetki anahtarını içerir. Worker klonları, provider oturumları
ve secret-store kimlik bilgileri dışarıda kalır. Dosyalar 0600, dizinler 0700 olmalıdır.
Değiştirilmiş bir setin SHA değerlerini yeniden yazmak yeterli değildir; verify şifreli
zarfın doğrulamasını da yapar.

Önce hedef servisi durdurun. Boş hedef doğrudan kullanılabilir; dolu hedef için
`--confirm-target /tam/mutlak/hedef` ekleyin. Başka kurulum kimliğine bağlı hedef reddedilir.
Mevcut kurulumda restore komutunu o kurulumun proje kökünden çalıştırın; başka bir hedefin
yapılandırılmış yerleşimi uyumsuzsa ret verilir. Eski durum `.damaged-<uuid>` kopyalarında korunur. Taşınan kimlik açıkça raporlanır,
installationId korunur; `deckent init identity --keep` operatörün açık onayını ister.
Kurulum içindeki config yolları taşınır; dış yollar korunur. Restore zamanlamayı off yapar.
Servisi açmadan dışarıda kalan kimlik bilgilerini yeniden sağlayın.
`BACKUP_RESTORE_INCOMPLETE` halinde ara dizini, eski kopyaları ve dış audit kayıtlarını
teşhis için koruyun; kaynakların tamamı tek atomik işlemle yayınlanmaz.

Etkileşimli config seçicisinden `backup.schedule` için off, daily veya before-upgrade;
`backup.retention` için 3, 7, 14 veya 30 seçin. Daily servis açıkken çalışır;
before-upgrade ledger migration öncesinde çalışır. `BACKUP_PASSPHRASE` değerini seçili
secret store'a mevcut `secret set` maskeli/stdin akışıyla sağlayın. Varsayılan environment
backend için değer servis başlatıcısından sağlanmalıdır. Parola yoksa before-upgrade
migration engellenir. Yalnız doğrulanmış zamanlanmış setlere saklama sınırı uygulanır;
başka adlı operatör dosyaları korunur. Servis kapanışı devam eden yedeklemeyi bekler.

Audit kayıtları parolasız olarak principal, scope ve policy taşır. Create/verify kayıtları
`audit/backup-operations`, restore kayıtları setin yanındaki `.deckent-backup-audit`
altındadır; ledger'ın değiştirilmesi restore niyetini silemez. Güvenilir yetki kurulmadan
önceki ret mühürlenemez ve depolama etkisi üretmez. Linux kernel kilidi doğrulanmıştır;
desteklenmeyen platformda restore reddedilir. KMS, bağımsız inceleme, paket kabulü ve
owner DOGFOOD kararı ayrı kapılardır.
