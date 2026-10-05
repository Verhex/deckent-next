# Deckent

English: [README.md](README.md)

[![CI](https://img.shields.io/github/actions/workflow/status/Verhex/deckent-next/ci.yml?branch=main&label=CI)](https://github.com/Verhex/deckent-next/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Verhex/deckent-next)](LICENSE)
[![Node engines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&color=43853d)](package.json)
[![Pre-release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.version&label=pre-release&color=orange)](CHANGELOG.md)

<!-- Node and pre-release badges read public main package.json, not this local branch.
Keep package.json version and CHANGELOG.md release line together at each release.
npm badges: enable only after first publish of deckent to npm; verify package identity first.
[![npm version](https://img.shields.io/npm/v/deckent)](https://www.npmjs.com/package/deckent)
[![npm downloads](https://img.shields.io/npm/dm/deckent)](https://www.npmjs.com/package/deckent)
-->

Deckent, insan, yapay zekâ ve araçların solo kullanımdan kurumsal çalışmaya kadar yetkilendirilmiş,
koordine edilmiş ve doğrulanabilir işler yapmasını sağlayan, müşterinin kendi ortamına kurduğu bir
Agent OS ürünüdür. Core, Apache-2.0 lisanslı açık kaynaktır ve tek başına çalışır; proprietary Enterprise
ayrı dağıtılır. Sağlayıcıdan bağımsız, yerel çalışmayı esas alan yapay zekâ ajan orkestrasyon runtime'ıdır.
Tek çekirdek ve tek tipli uygulama sözleşmesini bugün CLI, etkileşimli terminal (akışlı ajan turları,
onaylar, dosya düzenleme ve sandbox olmayan host shell), MCP sunucusu ve SDK
(`import … from 'deckent'`) kullanır. Runtime'a bağlı işlemler kurulu runtime servisine gider;
kurulum, gözlem ve bazı SDK/patch işlemleri doğrudan composition katmanına bağlanır.
Henüz HTTP API yoktur; Dashboard ve Desktop aynı servislerin gözlem/operatör uygulamaları olarak
planlanmıştır. Bugün yalnız sürümlü terminal–desktop köprü sözleşmesi vardır.

## Durum

**1.0.0-alpha.4 (2026-10-03'te canlı), clean-room port sürüyor.** Tamamlanan yetenekler
[COMPLETED-PLAN.md](COMPLETED-PLAN.md), kalan işler [PLAN.md](PLAN.md) içindedir. Kimde-ne-var ve sıradaki
adım host süreç panosundadır (`node .agents/refactor/board.mjs show`). Canlı gözlem için `deckent monitor`
her kurulumu tek salt-okunur görünümde gösterir. Geliştirme dogfood'u (Deckent işçilerinin izole bir
kurulumda Deckent kartlarını yazması) sınırlı denemelerle yürütülür; DOGFOOD resmen kapalıdır.
Legacy kod tabanının kalan yetenekleri tek tek taşınır; her landing sözleşme testleri ve gerçek binary
kanıtıyla gelir.

`deckent` npm'de yayımlanmamıştır (2026-10-03 registry sorgusu E404); aşağıdaki kaynak kurulumunu kullanın.
Canlı alpha.4 bilgisi kayıtlı sürüm durumudur; bu dokümantasyon şeridinde yeni runtime gözlemi yapılmadı.
CI'ın altı hücresinin hepsi (Linux, macOS, Windows × Node 24/26) zorunludur (owner 2026-10-03). Bu yüzden açık
macOS/Windows platform borçları kapanana kadar CI rozeti kırmızı kalır; kırmızı rozet gürültü değil, gerçekten kırılan bir hücredir.

## Bugün mevcut özellikler

Aşağıdaki kapsam [yetenek haritası](.deckent/docs/plan/capability-map.md#bugün-ne-var-ne-eksik) ve
[alpha.3 sürüm kaydına](CHANGELOG.md) dayanır. Her yeteneğin kullanımı kurulu profil ve policy ile sınırlıdır.

- Run/Task/Attempt kabulü, bağımlılık sıralaması, rezervasyon ve kalıcı SQLite ledger;
  yönetilen yerel runtime servisi, iptal ve kurtarma.
- Git tabanlı attempt çalışma alanları, native Claude/Codex profilleri ve paketli bootstrap dahil
  Docker işçileri; saklanan patch, ayrı integration adayı, teslim, adoption ve release.
- Yerel OS kimliği, company kapsamlı policy, audit ve ortak onay broker'ı; kanıtlanabilir insan
  onayı, zaman aşımıyla park edilen Run'lar ve doğrulanmamış kanıtın insan tarafından kabul/reddi.
  MCP onayları gözlemler; onay kararı vermez.
- İstemci × faturalama kanallı model kataloğu v3, tam model aktivasyonu, sağlayıcı çağrısı,
  harcama/kota audit'i ve yerel vLLM sohbeti. Katalog kaydı native destek kanıtı değildir.
- Akışlı turlar, araçlar, izin modları, MCP istemcisi ve bağlam sıkıştırmalı etkileşimli terminal;
  salt-okunur kurulum monitörü, registry'den türetilen ayarlar ve iki dilli CLI yardımı.
- Danışma amaçlı `deckent decide` portu; tavsiye yürütme yetkisi vermez. Mimari bütçeler,
  bağımlılık/i18n kapıları ve yalnız küçülebilen hardcode ratchet geliştirme sözleşmesini korur.

Mission/`do`/otonom iş süreci koordinasyonu, tam Brain/Auditor/Nervous döngüleri, Enterprise
SSO/fleet/HA, uzak HTTP API, Desktop ve Dashboard açık iştir. Host kernel'ini paylaşan Docker işçisi
VM garantisi vermez; etkileşimli terminalin host shell'i sandbox değildir.

### Worker araç sürümlerinin güncelliği

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

### Worker image sürümleri

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

### Native coding profilleri

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

### Patch muhafazası ve integration

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

## Gereksinimler

- Linux veya Windows WSL2 üzerinde Node.js ≥ 24.15.0 (SQLite ≥ 3.51.3 içerir; Node 24 ve 26 desteklenir).
- Docker (exact-docker worker yürütmesi; image tarifi `assets/worker-image/` içinde).

## Kurulum ve çalıştırma

Kaynak kodu indirin:

```sh
git clone https://github.com/Verhex/deckent-next.git
cd deckent-next
```

```sh
npm ci
npm run build
node dist/composition/core/cli/internal/entry.js --version
```

Kurulum, mevcut kullanıcıya ait ve grupça yazılabilir proje/bootstrap journal dizinlerini
(örneğin `0775`) kabul eder; diğer kullanıcılara yazma izni veren dizinleri reddeder.
Grup üyeleri dizin girdilerini değiştirebilir; journal namespace muhafazası o grupla paylaşılır.
Journal dosyaları yine mevcut kullanıcıya ait, tek hard link'li ve private `0400`/`0600` izinli
olmalıdır. Yeni dizinlerin varsayılanı `0700`'dür. Config yayımı, policy, artifact ve worker
kaynakları daha sıkı, ayrı kontrollerini korur. Grupça yazılabilir proje, ortak yazılabilir ürün
veri kökünün desteklendiği anlamına gelmez.

## Geliştirme host'u

Bu checkout yürütme çalışma alanıdır. `deckent-dev` salt-okunur refaktör referansıdır;
runtime ve worker'ları başlatılmaz. Yerel geliştirme girişleri:

```sh
node .agents/refactor/next-entry.mjs cli --version
node .agents/refactor/next-entry.mjs cli workers watch --scope pilot
node .agents/refactor/next-entry.mjs mcp
# Yerel SDK betikleri aynı ortamı ve cwd'yi kullanır:
node .agents/refactor/next-entry.mjs node /absolute/path/to/script.mjs
```

Host girişi cwd'yi bu checkout'a, `DECKENT_GLOBAL_HOME` değerini checkout dışındaki
`~/.local/state/deckent-next-dev` konumuna sabitler (runtime paketli bubblewrap'i oraya kopyalar; proje
içindeki bir başlatıcı reddedilir). Proje runtime verisinin başka yere yönlenmesini önlemek için miras alınan `DECKENT_HOME`
değerini kaldırır. Her projenin `.deckent/config.json` dosyası kendi `layout.root` değerini seçmeye
devam eder. `DECKENT_GLOBAL_HOME`, CLI/MCP/SDK'nın ortak config girdisidir; global config/state dizinini
proje verisinden bağımsız seçer. Verilmezse kurulu ürünün varsayılanları değişmez. Sağlayıcı kimlik
bilgisi taşımaz, legacy state'i migrate etmez.

Yerel gözlemci yalnız açıkça yapılandırılmış `inspection.workers.sources` kaynaklarını okur ve
kaynak policy kontrollerini korur. Docker worker'ı attempt checkout'unu `/workspace` olarak görür;
host depolaması `<layout.root>/workspaces/<attempt-hash>/tree` altındadır. `worker.hb`, `worker.log`,
`worker.result`, `tree` yanında ve worker mount'unun dışında host'a ait gözlemlerdir. Log özetleri
güvenli durum/diagnostic alanlarını gösterir; keyfî sağlayıcı çıktısını açmaz. `Ctrl+C` yalnız görünümü
durdurur. `pilot` kapsamı ve yerel kaynak kataloğu geliştirme fixture'larıdır, kurulu ürünün
varsayılanı değildir. DOGFOOD kapalı kalır. MCP config değiştiğinde açık istemciler yeniden bağlanmalıdır.

Kimde-ne-var ve sıradaki adım süreç panosundadır (`node .agents/refactor/board.mjs show`);
kabul edilmiş iş [PLAN.md](PLAN.md) içindedir. Pano Git/npm dışında host koordinasyon verisidir;
yetki veya canlılık kanıtı değildir. `deckent monitor` iş kabul etmeden kurulumları gözlemler.
Bir şeritte ortak host panosu yoksa rakip pano oluşturmak yerine lead'e devir bilgisi bırakın.

### Geliştirme süresi ölçümü (A02/W0-3)

`node .agents/refactor/effort.mjs`, geliştirme dilimlerinin gerçek süresini kaydeder.
M1–M5 tahminlerinin güncellenmesi için host aracıdır; ürün özelliği veya ikinci iş ledger'ı değildir.

```sh
node .agents/refactor/effort.mjs start A02-my-slice --milestone M1 --title "…" --actor "…" --kind active
node .agents/refactor/effort.mjs phase A02-my-slice blocked --reason owner-decision   # active|blocked|verification|rework
node .agents/refactor/effort.mjs pause A02-my-slice        # sonraki olaya kadar geçen süre bilinmez, aktif sayılmaz
node .agents/refactor/effort.mjs end A02-my-slice done     # done|canceled|handed-off
node .agents/refactor/effort.mjs report --format table     # tür ve milestone bazında gözlenen saatler
```

Olaylar `.deckent/host/effort/<slice>/` altında değişmez private dosyalardır; Git'e girmez.
Süre yalnız açık olaylar arasında sayılır; gözlenmemiş süre bilinmiyor olarak raporlanır, tahmin edilmez.
`--at <ISO>`, operatörün sağladığı zaman bilgisidir ve raporlarda ayrı sayılır.

### Landing öncesi kontroller

Değişiklikten önce [ARCHITECTURE.md](ARCHITECTURE.md) okuyun. Paket yönü, boyut sınırları, i18n ve
Markdown policy'si `scripts/lint-arch.mjs` ile denetlenir; ihlal build'i durdurur.

Her dilimde ilgili hedefli kontrolleri çalıştırın: typecheck, değişen kaynaklarda ESLint, `lint-arch`,
core-memory doğrulaması ve dokunulan testler (bkz. [CONTRIBUTING.md](CONTRIBUTING.md)).
Tam `npm run verify`, yalnız geniş özellik ekleyen partilerde ve owner istediğinde çalışır
(owner 2026-10-03); her dilimde tekrarlanan kapı değildir. Toplu lint komutu `npm run lint`'tir.
Hedefli/şerit Vitest koşuları `VITEST_MAX_FORKS=2`, tam verify varsayılan dört worker kullanır;
yerel testler 16 GB içinde kalır. Aktif test suite sırasında build alınmaz. Yazar kontrolleri,
bağımsız inceleme ve lead'in landing kapısından ayrı kanıttır.

## Katkı

Owner tarafından kabul edilmiş kartlar, insan ve worker branch/PR akışı, kontroller ve bağımsız
inceleme için [CONTRIBUTING.md](CONTRIBUTING.md) okuyun. [Davranış Kuralları](CODE_OF_CONDUCT.md) geçerlidir.

## Güvenlik

Core güvenlik açıklarını [SECURITY.md](SECURITY.md) üzerinden özel olarak bildirin.

## Lisans

Apache-2.0 (bkz. [LICENSE](LICENSE); DEPS-P0, owner 2026-09-29).
