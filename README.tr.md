<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/brand/lockup-on-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/brand/lockup-on-light.svg">
    <img src=".github/assets/brand/lockup-on-light.svg" alt="deckent" width="360">
  </picture>
</h1>

**Agent Control & Execution Plane**

deckent, insanların ve yapay zekâ ajanlarının isteklerini kendi makinelerinizde yetkili, yalıtılmış ve kayıtlı işlere dönüştürür.

*policy-driven agent runtime · governed execution · self-hosted agent control plane*

[![CI](https://img.shields.io/github/actions/workflow/status/Verhex/deckent-next/ci.yml?branch=main&label=CI)](https://github.com/Verhex/deckent-next/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Verhex/deckent-next)](LICENSE)
[![Node engines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&color=43853d)](package.json)
[![Pre-release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.version&label=pre-release&color=orange)](CHANGELOG.md)

[English](README.md) · [deckent nedir](#deckent-nedir) · [Nasıl çalışır](#nasıl-çalışır) · [Başlarken](#başlarken) · [İlk iş](#adım-adım-ilk-işiniz) · [Çalışırken görün](#çalışırken-görün) · [Gündelik kullanım](#gündelik-kullanım) · [Güvenlik](#güvenlik-ve-denetim) · [Bugün](#bugün-neler-çalışıyor) · [Yol haritası](#yol-haritası)

<img src=".github/assets/demos/tr/05-guvenlik.gif" alt="Bir yapay zekâ ajanının kabuk komutu ev klasörünü listelemeye ve deckent politikasına yazmaya çalışıyor: sandbox ev klasörünü gizliyor, yazma onay bekliyor, reddediliyor ve denetim kaydına geçiyor" width="880">

</div>

<!-- Node ve pre-release rozetleri bu yerel dalı değil, public main package.json'u okur.
Her sürümde package.json sürümü ile CHANGELOG.md satırını birlikte güncelleyin.
npm rozetleri: ilk npm yayınından ve paket kimliği doğrulandıktan sonra açılır. Kapsamsız `deckent` adı kullanılamıyor
(mevcut bir paketle çakışıyor); planlanan ad kapsamlı `@verhex/deckent` (önerilen ad; kesinleşmedi).
[![npm version](https://img.shields.io/npm/v/%40verhex%2Fdeckent)](https://www.npmjs.com/package/@verhex/deckent)
[![npm downloads](https://img.shields.io/npm/dm/%40verhex%2Fdeckent)](https://www.npmjs.com/package/@verhex/deckent)
-->

> [!NOTE]
> Bu README geçerli sürüm adayını anlatır: **beta ön sürüm `1.0.0-beta.1.2`**. [CHANGELOG.md](CHANGELOG.md) beta
> sürümlerini en yenisi başta listeler; eski sürümler [CHANGELOG-alpha.md](CHANGELOG-alpha.md) dosyasındadır.
> deckent henüz npm'de yok: [Başlarken](#başlarken) bölümündeki gibi kaynaktan kurun. npm paketi beta serisi içinde,
> büyük olasılıkla `@verhex/deckent` adıyla planlanıyor (ad henüz kesin değil). Sekiz kabul kapısı beta serisinde açık kalır; beta kabulü ayrıca duyurulur.
>
> Alpha.64 son alpha'dır. Onay kökeni, teslim modu, Brain kökeni veya resource-key kayıtları yazıldıktan sonra
> alpha.63.3 bunları okuyamaz: **alpha.63.3'e geri dönüş yoktur**. Kurtarma ileri sürüm düzeltmesi gerektirir;
> yükseltme öncesi yedekleri veri kurtarma için saklayın. [Bilinen sınırlar](docs/known-limits.tr.md).

## deckent nedir

Yapay zekâ ajanları artık komut çalıştırabiliyor, kod değiştirebiliyor ve iş sistemlerini çağırabiliyor. Artık asıl
zorluk onları çalıştırmak değil; zor olan, bir işe kimin izin verdiğini, nerede çalıştığını, kaça mal olduğunu ve nasıl geri
alınacağını bilmektir. Çoğu araç bunu ekranın başındaki kişiye bırakır.

deckent bu soruları yanıtlayan katmandır. Onu kendi makinelerinize kurarsınız; her istek, ister terminaldeki bir kişiden ister
MCP üzerinden bir yapay zekâ ajanından ya da bir betikten gelsin, aynı kontrollerden geçer: kimlik, kapsam, policy, onay ve
bütçe. İş sonra bir sandbox'ta ya da Docker işçisinde çalışır; her karar ve etki kalıcı bir deftere (ledger) yazılır.
Örneğin deckent ücretli bir model çağrısından önce çağrının tutabileceği en yüksek tutarı projenin bütçesinden ayırır; fiyat
bilinmiyorsa ya da bütçe yetmiyorsa çağrı, hiçbir şey gönderilmeden reddedilir.

Aynı temel, dizüstü bilgisayarında çalışan tek bir kişiye de çok ekipli bir şirkete de hizmet edecek biçimde kuruldu. İlk kullanım yazılım
işidir: kodlama işçileri bağlı Claude/Codex CLI ile bubblewrap alanında ya da uygun Docker profilinde çalışır;
deckent değişikliği proje dosyalarına ya da Git referansına teslim eder.
ERP veya CRM gibi iş sistemleri de aynı sözleşmeyi kullanır: tanımlı bir operasyon, yalnız kayıt değişmemişse uygulanan
bir yazma, asla iki kez uygulanamayan bir yeniden gönderme, kanıta dayalı kabul ve bir şeyin geri alınması gerektiğinde
planlı bir geri alma (telafi). Core bu sözleşmeyi ve genel bir HTTP hedefini içerir;
belirli ERP ürünleri için bağlayıcılar henüz yapılmadı.

Açık kaynak Core (Apache-2.0) tek başına çalışır. Kapalı kaynak (ticari) Enterprise sürümü, Core'u değiştirmeden
Core'un eklenti kayıt defterine (registry) takılan ayrı bir dağıtım olarak planlanıyor; Enterprise SSO, filo yönetimi ve ERP
bağlayıcıları orada yer alır. Aşağıda geçen kapsam (scope), Run ve onay gibi terimleri [sözlük](docs/glossary.tr.md) açıklar.

## Nasıl çalışır

İsteğinizi düz bir cümleyle söylersiniz. deckent bunu kontrol edilmiş, yalıtılmış adımlara çevirir; policy ve izin modunuz
izin vermedikçe hiçbir şey çalışmaz.

```mermaid
sequenceDiagram
  autonumber
  actor Siz
  participant T as Terminal
  participant R as Runtime servisi
  participant P as Policy ve onaylar
  participant B as Sandbox
  participant L as Defter
  Siz->>T: "Testleri çalıştır, kırılanı düzelt"
  T->>R: ajan turu (model + araçlar)
  R->>P: bu araç çağrısı burada, bu kişi için çalışabilir mi?
  alt onay gerekiyor
    P-->>Siz: onay penceresi (ne, nerede, kim, risk, süre)
    Siz->>P: bu sefer evet · hayır
  end
  P-->>R: izin verildi
  R->>B: komutu sandbox içinde çalıştır
  B-->>R: çıktı + değişiklik seti
  R->>L: çağrıyı, kararı ve etkiyi kaydet
  R-->>T: akışlı yanıt
  T-->>Siz: sonuç, her adım görünür
```

Bunu üç iş birlikte sağlar:

| | |
|---|---|
| 🗼 **Yönetir** | İnsanlar ve yapay zekâ ajanları için tek kimlik, kapsam ve policy modeli. Bir iş onay isterse pencere neyin onaylandığını tam gösterir: tam komut, nerede çalışacağı, kimin adına, risk, geri alınıp alınamayacağı ve süre. Bir rol tanımı (persona) ya da model tavsiyesi asla izin vermez. |
| 🛫 **Yürütür** | İşler (Run), görevler ve işçiler sizin makinelerinizde başlatılır, sıralanır ve kurtarılır. Ajanın kabuk komutları ve MCP sunucuları, makine sağlıyorsa sandbox içinde (bubblewrap, Landlock), kodlama işçileri profiline göre bubblewrap veya Docker içinde çalışır. Modeller Anthropic, OpenAI, DeepSeek, Z.ai ve Zhipu (GLM), OpenRouter, yerel bir sunucu ya da fiyatı yayımlanmış OpenAI uyumlu bir uç noktadan gelir. |
| 📜 **Kanıtlar** | Her karar ve etki kalıcı bir defter ve denetim izine yazılır. Onaylar mühürlenir, yamalar saklanır ve değişiklik teslimden önce deponuzun ayrı bir kopyasında denenir. |

Her giriş yolu aynı tipli sözleşmeyi kullanır: tek bir operasyon ve kontrol takımı. Runtime gerektiren işlemler proje başına tek bir yerel runtime servisinden
geçer; servis her çağrıda kimliği, kapsamı ve policy'yi kontrol eder, sonucu deftere yazar ve etkilerin yalnız policy'nin
izin verdiği yerde olmasına izin verir. Kurulum, gözlem ve bazı yama adımları aynı sözleşmeyi servis olmadan yerelde kullanır.

```mermaid
flowchart LR
  subgraph Giriş yolları
    T[Terminal]
    C["deckent komutu"]
    M[MCP sunucusu]
    S[SDK]
  end
  T & C & M & S --> R["Runtime servisi<br/>tek tipli sözleşme"]
  R --> P["Policy · onaylar<br/>kimlik · kapsam"]
  R --> L[("Defter · denetim")]
  R --> X["İşler · görevler · işçiler"]
  X --> B["Sandbox'lar<br/>bubblewrap · Landlock · Docker"]
  R --> G["Model sağlayıcıları<br/>API · OpenRouter · yerel"]
  R --> N["MCP sunucuları<br/>sandbox'lı · güven sabitli"]
```

## Başlarken

Sizin adınıza kurulum yapan AI asistanı için [AI kurulum rehberini](docs/ai-install.tr.md) kullanın; yalnız sizin tamamlayabileceğiniz adımları belirtir.

### Gereksinimler

- x86_64 üzerinde Linux ya da WSL2 ile Windows. Native Windows desteklenmiyor; macOS'ta runtime servisi henüz çalışmıyor
  (bkz. [Henüz olmayanlar](#henüz-olmayanlar)).
- Node.js: 24.x hattında 24.22.1 veya üstü ya da 26.12.1 veya üstü (Node 25 desteklenmez).
- Docker. Kaynaktan derleme onu kilitli bubblewrap sandbox'ını (0.13.0) derlemek için kullanır; Docker işçi profilleri de
  onu gerektirir. Derlemeden sonra Ollama ya da LM Studio gibi yerel bir model sunucusu kullanırsanız ilk sohbet ne Docker
  ne de ücretli bir çağrı ister.
- Git ve C derleme araçları (native yalıtım yardımcısı için).

### Kaynaktan kurulum

[Node.js indirme sayfasından](https://nodejs.org/en/download) desteklenen bir sürüm kurun; WSL2 için de Linux seçin.
Aynı terminalde `node --version` ve `npm --version` ile kontrol edin. Ubuntu'daki `apt install nodejs`, deckent'in
çalışmadığı Node 18'i kurabilir. npm `EBADENGINE` bildirirse Node'u [package.json](package.json) aralığına yükseltin,
yeni terminal açın ve klonun içinde `npm ci` komutunu yeniden çalıştırın.

npm paketi yayımlanana kadar deckent'i bir kez kaynaktan derleyin ve `deckent` komutunu bağlayın:

```sh
git clone https://github.com/Verhex/deckent-next.git
cd deckent-next
npm ci
node scripts/build-bwrap.mjs --arch all --out .pack/bwrap/first-build
node scripts/build-bwrap.mjs --stage-dev .pack/bwrap/first-build
npm run build
npm link
```

Klon zaten varsa `cd deckent-next` ile girip `git status` kontrol edin; üzerine yeniden klonlamadan oradan devam edin.
Klon tamamlanmış ama bağımlılık kurulumu yarıda kalmışsa `npm ci` ile devam edebilirsiniz; kaynak değişikliklerinizi
değil, `node_modules` dizinini yeniler. Klonun kendisi eksikse klasörü koruyup farklı bir dizine klonlayın.
Bubblewrap derlemesi başarısız olduysa yeni bir `--out` dizini kullanın; yalnız tamamlanan derlemeyi stage edip
ardından `npm run build` çalıştırın.

npm'in orta önem dereceli güvenlik açığı bildirimi, `npm ci` kurulum sonucundan ayrı bir bağımlılık denetimidir.
Kurulum başarıyla bittiyse derleme adımına geçilebilir; bu bildirim güvenlik onayı değildir. Etkilenen paketleri
`npm audit` ile inceleyip bakımcılara bildirin. Bu kurulumda kilit dosyasını koruyun; uyumsuz bağımlılık sürümleri
kurabilen `npm audit fix --force` komutunu çalıştırmayın.

Build `bubblewrap=present` ya da `bubblewrap=staged from …` ile biter. `BUBBLEWRAP_BUILD_REQUIRED` ile durursa Docker'a
ulaşılamamıştır: rootless → `systemctl --user start docker` (sonraki oturumlar için `systemctl --user enable docker`); sistem Docker'ı → `sudo systemctl start docker`; WSL'de Docker Desktop → Desktop'ı başlatın ve Settings > Resources > WSL Integration'ı etkinleştirin.
İki betik de uzun işten önce Docker'ı yoklar; hata, saptanan kuruluma uyan komutu (bilinmiyorsa üçünü) gösterir. İki `build-bwrap` komutunu yeni bir `--out` dizinle (örneğin
`.pack/bwrap/second-build`) yeniden çalıştırın, sonra `npm run build`. Ubuntu 24.04 ve sonrasında çekirdek, bubblewrap'ın ihtiyaç
duyduğu kullanıcı ad alanlarını engelleyebilir; deckent bunu söyler ve Landlock'a düşer. İki durumu ve bir yöneticinin
kısıtı nasıl kaldıracağını
[işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#kaynak-derleme-ve-sandbox-durumu) anlatır. Ön
koşulları ve sağlayıcı anahtarı gerektirmeyen tek bir testi [katkıcı hızlı başlangıcı (EN)](CONTRIBUTING.md#a-30-minute-quickstart)
gösterir.

### Mevcut kurulumu güncelleme

Mevcut kaynak klonunuzda `git status` ile kontrol edin; kurulacak revizyonu seçmeden önce yerel değişikliklerinizi koruyun.
Uzak revizyonları alın, `<revision>` yerine istediğiniz etiketi veya commit'i yazın ve kurulum adımlarını tekrarlayın:

```sh
git fetch origin --tags
git checkout <revision>
npm ci
node scripts/build-bwrap.mjs --arch all --out .pack/bwrap/update-build
node scripts/build-bwrap.mjs --stage-dev .pack/bwrap/update-build
npm run build
npm link
deckent --version
```

Her seferinde yeni bir `--out` dizini kullanın veya seçtiğiniz revizyondaki bubblewrap kilidiyle eşleşen, tamamlanmış bir derlemeyi stage edin.
Ardından mevcut proje klasörlerinin her birinde `deckent doctor` çalıştırın.
Doctor `INSTALLATION_IDENTITY_RELOCATED` bildirirse [bilinen sınıra](docs/known-limits.tr.md#kurulumun-konumu-değiştiğinde) bakın: kayıtlı kaynak olmayan projede `deckent init identity --keep` yeter; kayıtlı kaynakta ek adımlar gerekir ve bu betada sınırları vardır.

### Adım adım ilk oturum

Bu adımlar sizi boş bir projeden yönetilen bir sohbete ve onun maliyetine, deckent'ten çıkmadan götürür. deckent kaynak dizininin dışındaki
kendi proje klasörünüze geçin; bundan sonra her şey `deckent` ile yapılır.

```mermaid
flowchart LR
  I["1 · Kurulum<br/><sub>deckent init policy</sub>"] --> O["2 · Açın<br/><sub>deckent</sub>"]
  O --> P["3 · Sağlayıcı bağlayın<br/><sub>/provider · abonelik · yerel · API anahtarı</sub>"]
  P --> B["4 · Yalnız ücretli API<br/><sub>Bütçe oluştur · USD</sub>"]
  B --> M["5 · Model seçin<br/><sub>/model</sub>"]
  M --> W["6 · Çalışın<br/><sub>onaylar · modlar</sub>"]
  W --> U["7 · Kullanıma bakın<br/><sub>/usage</sub>"]
```

1. **Proje başına bir kez kurun.** *Kapsam (scope)*, policy'yi, iş kayıtlarını ve harcamayı bu projeye bağlayan sabit addır;
   bir klasör ya da sandbox değildir. Size ait, başka hesapların yazamadığı bir klasör kullanın. Ubuntu gibi grup yazma
   izniyle klasör oluşturan sistemlerde deckent, gerçek terminalde o klasörün iznini daraltmayı bir kez sorar.
   Evet yalnız o klasörün grup/diğer yazma iznini kaldırır; hayır klasörü değiştirmez ve `chmod go-w .` rehberini gösterir.
   `terminal attach --preview` için bu açık izin adımı salt okunur önizlemeden önce gelir; evetten sonra sonda gösterilen tam uygulama komutunu kopyalayıp çalıştırın.
   Komut `--scope <id> --apply --expect <özet> --command-id <uuid>` içerir; yeniden denerken aynı komut kimliğini koruyun.
   Proje bağlama bu açık komut kimliğini gerektirir; uygulama kendisi kimlik üretmez.
   Makine çıktısı (`--json`), TTY dışı ve AI çağrıları soru veya izin değişikliği olmadan reddedilir.
   `my-project` gibi bir kapsam seçin, policy'yi önizleyin ve kurun:

   ```sh
   deckent init policy --scope my-project --preview
   deckent init policy --scope my-project --apply
   deckent doctor
   ```

   Bu policy o kapsamda model bağlamanıza ve çağırmanıza, anahtar saklamanıza ve bütçe belirlemenize izin verir; bu
   eylemlerin her biri yine kontrol edilir ve kaydedilir. `deckent doctor` neyin hazır olduğunu söyler, kurulum
   başlayamıyorsa sıfır dışı kodla çıkar. `deckent init` aynı kurulumu adım adım yapar ve eksik kalanı listeler.
2. **Terminali açın**: `deckent`. Az önce kurduğunuz kapsamda açılır (`deckent --scope my-project` kapsamı açıkça seçer) ve
   runtime servisini arka planda başlatır. İlk açılışı Türkçe yapmak için `deckent --lang tr` kullanın; tercihi
   `deckent config set --global language '"tr"'` ile kaydedin (İngilizce: `'"en"'`; değer JSON olduğu için tırnaklar gerekir). `deckent init --lang tr` sırasında da seçebilirsiniz.
3. **Sağlayıcı bağlayın**: `/provider`. **Claude ile giriş**, **ChatGPT ile giriş (Codex CLI)**, yerel model ya da
   **API anahtarıyla bağlan** yolunu seçin. Abonelik girişi terminalinizde CLI'ın kendi akışından geçer; API anahtarı
   gizlenen alana yazılır ve deckent'te saklanır. Bu kapsamda bağlanacak tam modeli seçin.
   İlk abonelik onayı varsayılan olarak size ve AI aktörlerine açıktır; bağlı MCP istemcileri aynı AI kimliğini kullanır.
   Yalnız kendinize daraltabilirsiniz; arka plan/system kullanımı ayrı onay ister. 5. adım oturum modelini seçer.
4. **Ücretli API çağrıları için bütçe belirleyin.** Her ücretli tur kapsamın ortak USD bütçesinden pay ayırır; bütçe
   yoksa reddedilir. `/provider` içinde bağlantıları geçip aşağıdaki **Bütçe oluştur** satırına inin veya listeyi süzmek
   için `bütçe` yazın. Pencere **10 USD** seçili açılır; 5, 10, 25, 50 veya 100 USD seçin ya da **Başka tutar (ok tuşlarıyla)**
   üzerinden 1–1000 arasında tam dolar belirleyip onaylayın. Abonelik ve yerel modeller API anahtarı veya USD bütçesi
   istemez; aboneliklerde sağlayıcı planının sınırları geçerlidir.
5. **Model seçin**: `/model` ile, yalnız bu oturum için ya da varsayılanınız olarak. Henüz kullanamayacağınız model, nedeni
   ve çözümüyle kilitli görünür.
6. **Çalışın.** İsteğinizi düz bir cümleyle söyleyin. Araç çağrıları kurulumunuzun policy'sine ve izin modunuza uyar; size
   danışılması gereken her şey onay penceresini açar (bkz. [Güvenlik ve denetim](#güvenlik-ve-denetim)).
7. **Kullanıma bakın**: `/usage` bu konuşmanın kullandığı token'ları ve kapsamın bütçelerini gösterir. Bu, deckent'in
   ölçümüdür; sağlayıcının faturası değildir.

Bu ekranlar gerçek terminalden, alpha.53'te (120×36, varsayılan tam pencere düzeni) geçici bir projede ve küçük bir yerel
deneme modeliyle çekildi: hiçbir sağlayıcı çağrılmadı ve gerçek bir anahtar kullanılmadı. Her pencerenin üstündeki boş
konuşma satırları kırpıldı; başka hiçbir şey değiştirilmedi.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/09-model.png" alt="Bütçe yokken /model: Bütçe oluştur satırı, kullanılabilir yerel model, nedeniyle kilitli ikinci model"><br><sub><b>Bütçeden önce.</b> <code>/model</code> önce <b>Bütçe oluştur</b> satırını sunar. Yerel deneme modeli zaten kullanılabilir, çünkü yerel modeller bütçe istemez; bu kapsamın çağıramayacağı model nedeniyle kilitlidir.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/08b-saglayici-butce-satiri.png" alt="/provider bütçe eylemi ve sağlayıcı listesi"><br><sub><b>/provider.</b> Önce bağlantılar gelir; <b>Bütçe oluştur</b> için aşağı inin veya süzün. Bu görsel önceki sırayı gösterir.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/10-butce.png" alt="Hazır tutarlarla bütçe penceresi"><br><sub><b>Bütçe penceresi.</b> Hazır tutarlar ya da ok tuşlarıyla başka bir tutar.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/11-butce-adim.png" alt="20 USD'ye ayarlanmış bütçe adımlayıcısı"><br><sub><b>Başka tutar.</b> Tam dolar, 1 ile 1000 arası; onaylamadan hiçbir şey gönderilmez.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/12-model-hazir.png" alt="Bütçeden sonra /model: Bütçeyi değiştir satırı ve 20 USD bütçeyi kaydeden sistem satırı"><br><sub><b>Bütçeden sonra.</b> Çerçeveli sistem satırı bütçeyi kaydeder; ilk satır artık <b>Bütçeyi değiştir</b> der.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/13-kullanim.png" alt="Bir sohbet turundan sonra /usage penceresi"><br><sub><b>/usage.</b> Bu konuşmanın ölçtüğü token'lar ve kapsamın bütçeleri.</sub></td>
  </tr>
</table>

API anahtarı yolunda 3 ve 4. adımların komut satırı biçimleri de vardır; gizli anahtar girişi kişide kalır:

```sh
deckent secret set DECKENT_ANTHROPIC_KEY --main
deckent models create-budget --scope my-project --usd 20
deckent models connect --scope my-project --connection anthropic-api --command-id connect-1 --model claude-sonnet-5-5
```

`secret set` anahtarı gizli bir istemde sorar, borudan (pipe) gelen anahtarı reddeder. `--command-id` sizin seçtiğiniz
benzersiz bir addır; aynı komutu onunla yinelemek asla iki kez bağlamaz. Her sağlayıcının gizli adını, yerel ve
OpenAI uyumlu seçenekleri ve bugün abonelikle neyin çalıştığını
[işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#sağlayıcı-bağlantı-ayrıntıları) listeler.

## Adım adım ilk işiniz

Sohbet yalnız başlangıçtır. deckent işi planlar, planı siz onaylarsınız ve işçi kendisine ayrılan korumalı alanda çalışır.
Çalışma ağacı kipinde teslimi onaylamak yamayı proje dosyalarınıza yazar. Referans kipi bir Git referansına yazar;
dalı ilerletmek ayrı onaydır. İş hedefi ve dala alma hedefi yoksa varsayılan çalışma ağacıdır; yükseltilen kurulumlar da
dahildir. Teslim kartı hangi etkiyi onayladığınızı söyler.

```mermaid
flowchart LR
  S["Bir kez kurulum<br/><sub>bağlantı ya da Docker profili · havuz</sub>"] --> D["/do<br/><sub>plan · onay kartı</sub>"]
  D --> T["/tasks<br/><sub>işçiyi izle</sub>"]
  T --> L["/deliver<br/><sub>teslim kipini onayla</sub>"]
  L --> W["Çalışma ağacı<br/><sub>proje dosyaları değişir</sub>"]
  L --> R["Git referansı<br/><sub>dalı ilerletmek ayrı</sub>"]
```

En az bir commit'i olan Git projesinde ve bağlı bir modelle başlayın. Claude veya ChatGPT aboneliği için `/provider`
içinden giriş yapıp bağlanın, ardından işçiyi hazırlamak için `/setup` açın. Bu Claude/Codex CLI işçileri Linux/WSL'de
bubblewrap içinde çalışır ve Docker imajı istemez. CLI'a deckent dışında giriş yapmak bu kurulumu tamamlamaz.
Uygun bir Docker işçi profili kullanıyorsanız `/setup` onun imajını hazırlar veya seçer; imaj derlemek Docker ve ağ
erişimi gerektirir.
USD bütçesi yalnız ücretli API çağrılarına gerekir. Gerçek hesapla ve sıfırdan kurulumda ilk iş kontrolleri henüz
tamamlanmadı ([bilinen sınırlar](docs/known-limits.tr.md)).

### Bir kez yapılan kurulum

Paketle gelen Claude önerileri günlük işler için Opus 5.5'i, zor akıl yürütme işleri için
[Fable 5.2'yi](https://platform.claude.com/docs/en/models/fable-5-2/overview) kullanır.
Fable 5.2 için [Claude Code 2.1.321 veya sonrası](https://code.claude.com/docs/en/model-config) gerekir.
Fable 5.1 katalogda seçilebilir kalır; katalog kaydı ve öneriler modeli etkinleştirmez.
Fable 5.1'i bir rolde kullanmak için `deckent models roles set` ile o rolü açıkça atamanız gerekir.

`/setup` içinde işçiyi, yürütme ayarlarını, iş türünü ve işçi havuzunu seçin. Her adım neyin değişeceğini gösterir ve
yazmadan önce sorar. İmajı yalnız Docker işçisi için derleyin veya seçin; bazı ikinci sağlayıcı kurulumları hâlâ imaj
ister ([bilinen sınırlar](docs/known-limits.tr.md)).

```sh
# Projenizi kurun ve terminali açın; /setup işçi adımlarına geri döner.
deckent init
deckent
# Terminal dışında eksik adımları ve komutlarını görün.
deckent doctor
# Servis zaten çalışıyorduysa kurulumdan sonra yeniden başlatın.
deckent runtime restart
```

Komut satırından kurulum, mevcut işçi şablonu, Cursor'ın katalog adımı veya depo talimatı ayarları için
[işletim başvurusunu](.deckent/docs/architecture/operator-reference.tr.md#adım-adım-ilk-iş-kurulumu) kullanın.
Bağlantı kimlikleri, önizlemeler ve eski kurulumların adımları orada anlatılır.

### İşi çalıştırın

1. **İsteyin.** Terminalde `/do` yazıp isteğinizi sade sözlerle yazın (komut satırında `deckent do --request "<metin>"`).
   Bağlı bir model planlar; deckent planı her görev için bir kabul satırıyla basar:

   ```text
   Run <run-id> için plan · <durum>
   Görev t1: <görevin yaptığı iş> · tür coding · iş sınıfı <sınıf>
     Kabul: <sonucun karşılaması gereken ölçüt>
   Başlatılırken policy'nin denetlediği izinler: <her görev için bir task/execute>
   TTY onayınız bekleniyor: <onay-kimliği>, son tarih <saat>. Model bu işe yetki veremez.
   ```

   *İş sınıfı* (WorkClass), görevin gerektirdiği emeğin türüdür; işçiyi ve modeli o seçer.

2. **Onaylayın.** Bir kart Run'ı oluşturmayı onaylamanızı ister. Planı ve kabul satırlarını değerlendirin (kartın risk ve
   geri alma satırları planlar için henüz sınıflandırılmıyor), sonra `y`'ye basın. Kart 10 dakika sonra sona erer; model
   sizin yerinize onaylayamaz. Ardından gelen `Run <run-id> başlatıldı. /tasks veya /monitor ile izleyin.` satırı işin
   başladığını söyler; sonucun kabul edildiğini değil.
3. **İzleyin**: `/tasks` ya da `/monitor` ile (terminal dışında `deckent monitor`). Kodlama kabulü süreç sonucunu,
   kalıcı yamayı ve zorunlu sonuç raporunu, beyan edilmiş kabul kontrolleriyle denetler. İçerik bağımsız doğrulanmaz;
   rapor desteği ve tipsiz kontrol sınırları [bilinen sınırlarda](docs/known-limits.tr.md) kalır.
4. **Teslim edin**: `/deliver`. Başlığı, değişiklik özetini, kanıtı, riski ve evet ya da hayırın etkisini okuyun.
   Çalışma ağacı kipinde `y` yamayı commit ya da staging yapmadan proje dosyalarınıza yazar. Değişen dosya çatışmaları
   teslimi reddeder; kendi değişikliklerinizi koruyup kartın sonraki adımını izleyin. Geri alma ayrı çalışma ağacı
   onayıdır ve sonraki değişikliklerle çatışırsa reddedilir. Referans kipinde `y`, `refs/deckent/deliveries/` altına yazar;
   çalışma dosyaları ve index değişmez, dalı ilerletmek ayrıdır.
5. **Referans kipinde dalı ilerletin**, isterseniz ayrı bir `y` ile. deckent yalnız izin verdiğiniz ve kimsenin checkout etmediği bir dalı
   ilerletir; bu yüzden önce bir dal açın:

   ```sh
   git branch deckent/first-job HEAD
   deckent config set execution.adoption.targets '["refs/heads/deckent/first-job"]'
   ```

   Sonuca `git log deckent/first-job` ile bakın ve birleştirmeyi kendiniz yapın. Proje teslim kuyruğunu (servisin dal başına
   teslim kuyruğu) kullanıyorsa dalı ilerletme kendi onayıyla geri alınabilir; komutları
   [işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#teslim-kuyruğu-inceleme-ve-geri-alma) gösterir.

<img src=".github/assets/screenshots/tr/16-gorevler.png" alt="Henüz iş olmayan canlı /tasks penceresi" width="880">

<sub><b>/tasks.</b> İşçiler ve Run'lar tek bir canlı pencerede; iptal onay ister (burada boş: henüz arka plan işi yok).</sub>

## Çalışırken görün

Atılabilir bir kurulumda `1.0.0-beta.1.2` ile terminalden kaydedilmiş gerçek oturumlar. Model kullanan her sahne
modelini `/model` ile seçiyor, bu yüzden durum satırında modelin adı görünüyor. Onayları o kurulumdaki etiketli bir
sentetik kişi veriyor; model ve runtime bekleme süreleri kesildi.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/demos/tr/01-kurulum.gif" alt="deckent --version, yeni bir kurulumda deckent init, ardından ilk açılış"><br><sub><b>Kurulum.</b> <code>deckent --version</code>, ardından yeni ve atılabilir bir kurulumda <code>deckent init</code>: dil, kapsam, kurulumu kimin kullandığı, ilk kurulum izinleri, komut korumalı alanı ve son kontrol. İlk <code>deckent</code> açılışı sohbetten önce yönetim haklarını, model bağlantısını ve kodlama CLI'ını öneriyor. Model kullanılmıyor.</sub></td>
    <td width="50%"><img src=".github/assets/demos/tr/02-gorevler.gif" alt="/do üç salt-okunur görev planlıyor; izleyici yürütme için yer bekleyen bir görev gösteriyor; Run kabul ediliyor"><br><sub><b>Plan ve işçiler.</b> <code>/do</code> tek bir isteği üç salt-okunur göreve ayırıyor; plan kartı her görevin işçisini, Codex aboneliğinde gpt-6-luna'yı gösteriyor ve sentetik kişi onaylıyor. İzleyici bir görevin yürütme için yer beklediğini gösteriyor: bir abonelik girişi aynı anda bir işçi çalıştırıyor, bu yüzden görevler sırayla koşuyor. Run çıkış koduyla kabul ediliyor; içerik bağımsız olarak doğrulanmıyor. Planlayan: Claude Sonnet 5.5 (Anthropic API).</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/demos/tr/03-akis.gif" alt="Kabul ölçütüyle bir plan, çıkış koduyla kabul edilen işçi sonucu, teslim kartı ve commit'siz yazılan dosya"><br><sub><b>Plan, kanıt, teslim.</b> GPT-6.1 Sol (OpenAI API) tek bir görevi kabul ölçütüyle planlıyor ve sentetik kişi onaylıyor. Görev işçinin çıkış koduyla kabul ediliyor; teslim kartı değişen dosyayı ve satır sayılarını, işçinin raporunu kontrol edilmemiş bir beyan olarak ve “Sistem doğrulaması: kayıtlı değil” satırını gösteriyor. Sentetik kişi evet diyor ve dosya commit atılmadan çalışma kopyasına yazılıyor. İşçi: Claude Sonnet 5.5 (Claude aboneliği).</sub></td>
    <td width="50%"><img src=".github/assets/demos/tr/04-onay.gif" alt="Shift+Tab ile standart moda geçiş, bir kabuk komutu onay penceresini açıyor, ardından /mode"><br><sub><b>Onay ve modlar.</b> <kbd>Shift</kbd>+<kbd>Tab</kbd> standart moda geçiriyor; bu yüzden bir kabuk komutu onay penceresini açıyor: ne, nerede, kimin adına, kapsam, neden, risk, geri alma ve canlı bir süre. Sentetik kişi bir kez izin veriyor; <code>/mode</code> aynı modları listeliyor. Model: DeepSeek V4.1 Flash (DeepSeek API).</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/demos/tr/05-guvenlik.gif" alt="Sandbox ev klasörünü gizliyor; deckent politikasına kabukla yazma reddediliyor ve kayda geçiyor"><br><sub><b>Reddedildi ve kayda geçti.</b> Ajanın kabuğu, ev klasörünüzü gizleyen ve deckent yetki dosyalarını salt okunur tutan bir bubblewrap sandbox içinde çalışıyor. Politika dosyasına ekleme yapan kabuk komutu her zaman onay isteyen türden, tam otomatikte bile. Sentetik kişi Hayır diyor, hiçbir şey yazılmıyor ve denetim kaydı reddedilen çağrı için bir <code>policy-turn</code> kaydı tutuyor. Model: Claude Sonnet 5.5 (Anthropic API).</sub></td>
    <td width="50%"></td>
  </tr>
</table>

## Gündelik kullanım

### Terminalde

`deckent` etkileşimli terminali açar. Her slash komutu kendi penceresinde yanıt verir; <kbd>Esc</kbd> pencereyi kapatır ve
konuşmada metin yığını yerine tek bir çerçeveli `deckent sistemi` satırı bırakır. Ayarlar yazarak değil seçerek değişir:
`/config` bölümden anahtara, oradan izin verilen değerlere ilerler; her değişiklik policy'den geçer ve bir onaya
dönüşebilir. `/help` tüm komutları amaca göre listeler; en çok kullanılanlar şunlardır:

| Amaç | Komutlar |
|---|---|
| İş | `/do` iş iste · `/tasks` canlı iş · `/runs` tüm Run'lar; durdur, sürdür, kapat · `/deliver` · `/cancel` |
| Onaylar | `/approvals` bekleyen bir onayı seç ve karar ver |
| Ayarlar | `/provider` · `/model` · `/config` · `/mode` · `/mcp` · `/policy` |
| Bilgi | `/status` · `/usage` · `/context` · `/doctor` · `/monitor` · `/scope` · `/help` |

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/02-sohbet.png" alt="Sohbet turu: sizin satırınız Sen, yanıt deckent başlığı altında"><br><sub><b>Sohbet.</b> Sizin satırlarınız ve deckent'in yanıtları belirgin biçimde ayrışır; her turda süre ve token.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/05-onay.png" alt="Kabuk komutu için onay penceresi"><br><sub><b>Onay penceresi.</b> Ne, nerede, kimin adına, kapsam, neden, risk, geri alma ve canlı süre. Yanıtlar bir listedir; "bu oturum" ve "bu projede her zaman" yalnız policy sunduğunda görünür.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/04-durum.png" alt="/status penceresi"><br><sub><b>/status.</b> Önce insan dilinde özet; kimlikler, süreç ve build ayrıntıda.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/06-tam-erisim.png" alt="Tam erişim modu göstergesi"><br><sub><b>Modlar.</b> <kbd>Shift</kbd>+<kbd>Tab</kbd> yetkili olduğunuz modlar arasında döner; tam erişim açıkça işaretlenir.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/03-yardim.png" alt="Amaca göre gruplu /help penceresi"><br><sub><b>/help.</b> Komutlar amaca göre gruplu, her biri tek satır; pencere kaydırılır.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/07-mcp.png" alt="/mcp penceresi"><br><sub><b>/mcp.</b> Adım adım sunucu ekleme; yapılandırılmış her sunucu güven durumunu ve nerede çalıştığını gösterir (burada ağ erişimli bir sandbox).</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/08-saglayici.png" alt="Sağlayıcı türlerini listeleyen /provider penceresi"><br><sub><b>/provider.</b> OpenRouter dahil her sağlayıcı bağlantı durumuyla.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/tr/14-ayarlar.png" alt="Terminal temasını seçen /config penceresi"><br><sub><b>/config.</b> Bölüm, anahtar, sonra izin verilen değerlerden biri; geçerli olan işaretli.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/tr/15-sistem-satiri.png" alt="Kapanan pencerelerin bıraktığı çerçeveli sistem satırları"><br><sub><b>Sistem satırları.</b> Kapanan her pencere tek bir çerçeveli özet satırı bırakır.</sub></td>
    <td width="50%"></td>
  </tr>
</table>

### Komut satırında

`deckent` komutu her çağrıda tek bir iş yapar ve insanlar için metin basar; aynı sonucu veri olarak almak için `--json`
ekleyin. Bir kişinin terminalinde, bir şeyi değiştiren komutlar eksik değerleri ok tuşlarıyla seçtirir ve bir kartla
onaylatır; yapay zekâ araçları, borular ve CI her değeri bayrakla verir ve onlara asla sorulmaz. `deckent --help` tüm
komutları, `deckent <komut> --help` ayrıntıyı gösterir.

```sh
deckent doctor                            # bu kurulumun sağlığı
deckent monitor                           # kurulumların ve işlerin canlı, salt okunur görünümü
deckent run list                          # bu kapsamın Run'ları, en yenisi önce
deckent approval list                     # önce bekleyen onaylar, kalan süreyle
deckent report --scope my-project --run <id>   # bir Run'ın maliyet ve kabul kanıtı
deckent audit verify                      # denetim geçmişini doğrula
deckent backup create --scope <kimlik> --set <klasör>   # doğrulanabilir bir kurtarma seti yaz (parola istemde)
deckent policy grants --mine              # kalıcı "her zaman" izinleriniz
deckent memory                            # kapsamın hafıza günlüğü: olgular ve dersler
deckent agents                            # kapsamın ajanları ve skill'leri
deckent models roles show                 # hangi model hangi rolde
```

### Bir yapay zekâ istemcisini MCP ile bağlayın

MCP iki yönde çalışır. deckent'in kendi ajanına bir MCP sunucusu vermek için onu `/mcp` ile ya da
`deckent mcp add context7 -- npx -y @upstash/context7-mcp` ile ekleyin. Sunucu ancak siz ona güvendikten sonra başlar ve
varsayılan olarak ağ erişimi ve kendi ev klasörü olan bir sandbox içinde çalışır; `host` için yapılandırılmış bir sunucu
sandbox'sız çalışır, her birinin nerede çalıştığını `/mcp` gösterir.

Dışarıdaki bir yapay zekâ istemcisinin deckent'i kullanması için deckent'in stdio MCP sunucusu `deckent-mcp`'yi o istemciye
kaydedin; Claude Code'da bu `claude mcp add deckent -- deckent-mcp --project /proje/yolu` komutudur. Araçlarının çoğu runtime
servisine ihtiyaç duyar; bu yüzden `deckent runtime serve` açık kalsın. İstemci, başlangıçta yalnız gözlem yapabilen ayrı bir
MCP aktörü olarak çalışır. Daha fazlasına izin vermek için `/policy` penceresini (**MCP izinleri**) açın, bir kapsam ve bir yetki
grubu seçin, değişecek kuralları inceleyip izni verin; aynısı komut satırından da yapılır:

```sh
deckent policy mcp list --json
deckent policy mcp grant --group work --scope my-project --preview
deckent policy mcp grant --group work --scope my-project --apply --expect <önizleme-özeti>
```

Uygulama kendi terminalinizde onayınızı ister ve denetime yazılır. İnsan ve yapay zekâ yetkisinin nasıl ayrıştığını
[Policy ve AI](docs/policy-and-ai.tr.md) anlatır.

### Runtime servisi

Model turları, onaylar, `/do` ve kurtarma her proje için tek bir yerel runtime servisinde çalışır. `deckent`, çalışan servis
yoksa onu arka planda başlatır; terminalin başlattığı servis 15 dakika iş almazsa kendiliğinden durur. `deckent runtime serve`
onu ön planda çalıştırır; `deckent runtime restart` güncel derleme ve yapılandırmayla yeniden başlatır, `deckent runtime
describe` çalışanı gösterir. Loglar, durdurma izni ve eski kurulumlar için
[işletim başvurusuna](.deckent/docs/architecture/operator-reference.tr.md#runtime-servisi) bakın.

## Güvenlik ve denetim

Ajanın yaptığı her araç çağrısına iki şey birlikte karar verir: kurulumunuzun policy'si ve seçtiğiniz izin modu.
Policy sınırları çizer; mod yalnız bu sınırların içinde size ne sıklıkla sorulacağını seçer ve bir yasak (deny) kuralı her
zaman önce gelir. Yetkili
olduğunuz modlar arasında <kbd>Shift</kbd>+<kbd>Tab</kbd> ya da `/mode` ile geçersiniz.

```mermaid
flowchart LR
  S["Standart<br/><sub>düzenlemeler çalışır · kabuk ve MCP sorar</sub>"] -->|Shift+Tab| C["Dikkatli<br/><sub>düzenlemeler de sorar</sub>"]
  C -->|Shift+Tab| A["Tam otomatik<br/><sub>sandbox'lı kabuk ve MCP çalışır</sub>"]
  A -->|Shift+Tab| F["Tam erişim<br/><sub>sahip izni · bu oturum · her çağrı denetimde</sub>"]
  F -->|Shift+Tab| S
  H[["Sabit zemin · her modda kapalı<br/>deckent durumu, policy, onaylar, denetim, kimlik bilgileri"]]
```

| Mod | Sormadan çalışır | Önce sorar |
|---|---|---|
| **Standart** | Okumalar, sıradan dosya düzenlemeleri | Kabuk komutları, korunan yollar, MCP çağrıları |
| **Dikkatli** | Okumalar | Her düzenleme de |
| **Tam otomatik** | Düzenlemeler, sandbox içinde kalan kabuk komutları, MCP çağrıları | Host kabuğu, yıkıcı komutlar (`rm -r`, …), korunan yollar |
| **Tam erişim** | Policy'nin sabit zeminin üstünde izin verdiği her şey; her çağrı denetime yazılır | Sabit zemin ve policy'nin hâlâ istediği onaylar; kurulum sahibinin izni gerekir (tek kişilik kurulumda bu sizsiniz); bu oturum için açılır ya da `/mode start full-access` ile başlangıç kipiniz olarak saklanır |

Tam otomatik ve tam erişimi kurulum sahibi kendi terminalinde
`deckent init policy --scope <id> --modes full-auto,full-access --preview`, ardından `--apply` ile açar; yapay zekâ
araçları, borular ve CI açamaz. Ajanın kabuk komutları sandbox içinde çalışır: ilk üç modda proje, çağrının onayı içinde
yazılabilir; `.git` salt okunur, ev klasörünüz gizli ve ağ kapalıdır. Tam erişim açık bir bubblewrap sandbox'ı ister; bu
sandbox ağı ve ev klasörünü açar ama deckent'in kendi durumunu ve bilinen kimlik bilgisi dosyalarını yine gizler. Sandbox
yoksa kapalı bir mod host'a düşer ve bunu söyler (varsayılan `terminal.shell.realm: prefer-sandbox`); bu yolun dosya
sistemi sınırı yoktur, bu yüzden yalıtım şartsa `require-sandbox` seçin. Her görünümü ve sınırlarını
[işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#sandbox-görünümleri) anlatır.

### Onaylar

Bir çağrı size danışmak zorundaysa onay penceresi tam komutu, nerede çalışacağını, kimin adına olduğunu, neden sorduğunu,
riski, geri alınıp alınamayacağını ve ne kadar süreniz kaldığını gösterir; kimse karar vermezse hiçbir şey çalışmaz. Model asla
onay veremez. Bir araç çağrısının onayını yalnız o turu başlatan terminal yanıtlayabilir. Çalışan bir turu olmayan bekleyen
onaylar (örneğin bir `/do` planı) doğrulanmış bir terminalde `/approvals` ya da `deckent approval list` ile seçilip
yanıtlanır. Bir kez yanıt verebilirsiniz; policy sunuyorsa bu oturum için ya da bu projede her zaman diye de; "her zaman" izinlerinizi `deckent policy grants --mine` listeler, `deckent policy revoke`
kaldırır. Bir iş sistemi operasyonunda kart operasyonu, hedefi ve girdinin kısa bir özetini gösterir; yazılacak alanlar tek tek
henüz gösterilmez.

### API anahtarları

Sağlayıcı anahtarını bir kez, `/provider`'ın gizlenen alanına ya da `deckent secret set AD --main` ile kaydedin (gizli bir
istem; argüman olarak ya da borudan verilen anahtar reddedilir). Anahtarı `ANTHROPIC_API_KEY`, shell profili ya da `.env`
dosyasına koymayın: başka araçlar oraları okur. Linux, WSL ve macOS'taki yeni kurulumlar anahtarları şifreli bir depoda
tutar. Sağlayıcı çağrıları anahtarı runtime'ın içinde çözer; anahtar bu yüzden hiçbir isteme, shell ortamına, ajana ya da
işçiye ulaşmaz. Şifreli deponun açma anahtarı yanında durur; bu yüzden sizin hesabınızla çalışan başka programlar onu yine
açabilir. Deponuzu kimin okuyabileceğini `deckent doctor --verbose` söyler; depoları ve daha sıkı bir kurulumu
[işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#gizli-depolar-ve-katı-kurulum) gösterir.

### Harcama

Her kapsamın, tüm API sağlayıcılarının ortak kullandığı tek bir USD bütçesi vardır. deckent ücretli bir çağrıdan önce
çağrının tutabileceği en yüksek tutarı ayırır; sonra çağrıyı sağlayıcının bildirdiği kullanım ile doğrulanmış yayımlanmış
fiyatın çarpımından kesinleştirir (OpenRouter çağrıları OpenRouter'ın bildirdiği ücretten kesinleşir). Fiyatı doğrulanmamış
uzak bir model reddedilir. Son kullanımını hiç bildirmemiş bir çağrı, siz `deckent models reconcile-spending` ile çözene kadar
ayrılmış kalır. Kesinleşen bir tutar ayrılandan fazla çıkarsa kapsam yeni ücretli çağrıları durdurur; dondurmayı
`deckent models revise-budget --scope <id> --usd <n> --unfreeze` ile kaldırırsınız. Kesinleşen tutar deckent'in kendi
hesabıdır, sağlayıcının faturası değildir; bu yüzden sağlayıcı hesabınızda da bir harcama sınırı tutun. Fiyat kademelerini ve
OpenRouter ayarlarını [işletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md#harcamanın-kesinleşmesi)
anlatır.

## Bugün neler çalışıyor

- **Terminalde ajanla çalışın**: akışlı turlar, dosya düzenleme ve sandbox'lı kabuk, onay ve izleme pencereleri, izin
  modları, MCP araçları, konuşma sıkıştırma; Türkçe ve İngilizce.
- **İşi sade sözlerle isteyin**: `/do` işi kabul ölçütleriyle planlar, siz onaylarsınız, bir kodlama işçisi (Claude Code,
  Codex ya da Cursor) seçilen bubblewrap veya Docker yolunda çalışır; `/deliver` teslim kipine göre proje dosyalarına
  ya da Git referansına yazar. Dalı ilerletmek ayrı onay ister.
- **İşleri yönetin**: Run'lar, görevler ve denemeler (bir görevin her denenişi) başlatılır, sıralanır, durdurulur, sürdürülür, iptal edilir ve
  kurtarılır; hepsi kalıcı bir SQLite defterine yazılır.
- **Model seçin ve maliyeti tutun**: kendi anahtarınızı bağlayın, modeli oturum için ya da varsayılan olarak seçin, yerel
  modelleri çalıştırın, Anthropic istem önbelleğini kullanın ve her ücretli çağrıyı belirlediğiniz bütçenin içinde tutun.
- **Yönetişim**: yerel kimlikler, kapsamlı policy, her yüzey için tek onay aracısı, listeleyip kaldırabileceğiniz
  kalıcı izinler ve doğrulayabileceğiniz bir denetim izi.
- **İşletin**: salt okunur görünüm için `deckent monitor`, sağlık için `deckent doctor`, ayarlar için `deckent config`;
  isterseniz zamanlanmış, doğrulanabilir kurtarma setleri için `deckent backup create|verify|restore`.
- **İmzalı içeriği yönetin**: imzalı ajan ve skill paketlerini içe aktarıp doğrulayın, güven ve iptal kayıtlarını inceleyin,
  değişiklikleri kapsama bağlı kartlarla kararlaştırın. Halka açık Hub bağlantısı dağıtım kurulumu ister; varsayılan kaynak açılmaz.
- **Kurulumu önizleyerek kaldırın**: `deckent uninstall` verilerimi koru (varsayılan), bekleyen işleri koru ve her şeyi sil
  (önce yedek) seçeneklerini sunar; `--dry-run --json` her planı gösterir. Uygulamak terminal kartı ister; imajlar korunur.
  Adımları ve kalan sınırları [AI kurulum rehberi](docs/ai-install.tr.md#kaldırma) anlatır.
- **Kodda olan, henüz gerçek kullanımda kanıtlanmamış çekirdek katmanlar**: sistem her iş türü için işçi modelini
  görebildiğiniz bir listeden seçer; hafıza kabul edilen işten dolar ve onu siz ya da bağımsız bir değerlendirici doğrular;
  kaybolan işçiler tespit edilir ve öneri olarak kaydedilir; Brain bir korumalı alan içinde, sizin kendi girişiniz ve
  onayınızdan sonra kendi Claude aboneliğinizle planlayabilir; ajanlar ve skill'ler sürümlüdür ve onlara yapılan her AI
  değişikliği imzalıdır. Her anahtar (hafıza, kaybolan işçi tespiti, kurtarma, ajan istatistiği) kapalı başlar ve hiçbir
  şeyi uygulamayan bir gölge kipi vardır; gölgedeki hafıza doğrulama ve kurtarma yine de modelini çağırır, yani veri o
  sağlayıcıya gider ve çağrı harcanır. Otomatik kurtarma ancak ölçülmüş kuralı yükseltip kesin eylem iznini verdikten ve
  kipi açtıktan sonra devreye girer. Yeni haklar kurulum sahibinin policy yükseltmesiyle gelir: ilk kurulum şablonundan gelen
  policy için `deckent policy upgrade --template current`, elle yazılmış policy için
  `deckent init policy --scope <id> --upgrade --person <issuer>/<subject>`
  ([bilinen sınırlar](docs/known-limits.tr.md#çekirdek-katmanlar)).

### Henüz olmayanlar

- **npm paketi yok.** npm paketi yayımlanana kadar kaynaktan kurun.
- **Masaüstü uygulaması, web paneli ve uzak HTTP API yok.** Terminali, `deckent` komutunu, MCP'yi ya da SDK'yı kullanın.
- **Çok adımlı iş süreçlerinin koordinasyonu henüz yok.** Bir istek bir Run olur; birden çok turu ve beklemeyi
  koordine eden daha uzun süreçler planlanıyor.
- **ERP ya da CRM bağlayıcısı yok.** Operasyon sözleşmesi ve genel bir HTTP hedefi var; ürün bağlayıcıları yok.
- **Teslim hiçbir zaman kendiliğinden olmaz.** Bir kural kuyruktaki her iş için teslim *edip etmeyeceğini* kaydeder ama yalnız
  tavsiye verir; her teslim, dalı ilerletme ve geri alma sizin `y`'nizi bekler.
- **Kodlama içeriği bağımsız doğrulanmaz.** Kontroller işçinin nasıl bitirdiğine, saklanan yamaya, zorunlu rapora ve
  raporladığı kabul kontrollerine bakar; içeriğin isteğinizi karşılayıp karşılamadığını bağımsız değerlendirmez.
- **Aboneliklerin sınırları var.** Claude ve ChatGPT (Codex CLI) bağlantıları Linux/WSL'de bubblewrap içinde araçlı sohbet,
  kodlama işçisi ve Brain sunar. Claude'un eski Docker abonelik seçeneği reddedilir. Ayrı ChatGPT tarayıcı girişi sohbete
  açıktır, ancak onun işçisi henüz etkin değildir. Giriş yapmak tek başına işçiyi hazır yapmaz; gerçek hesap kontrolleri,
  tamamlanmış sürümde uçtan uca kullanım ve beta kabulü hâlâ açıktır.
- **Platformlar.** Native Windows desteklenmiyor. macOS'ta yerel runtime servisi henüz çalışmıyor (soketi yalnız Linux'ta
  var); bu yüzden sohbet, işler ve yedekleme orada kullanılamaz. Teslim, dalı ilerletme, geri alma ve anahtar izni yalnız Linux'ta
  (WSL dahil) bulunan bir terminal tanığı ister, diğer sistemlerde reddedilir. arm64 paketlenmiyor. Docker işçisi host
  çekirdeğini paylaşır; sanal makine değildir.
- **Kurtarma setleri tamamen şifreli değil.** Setin içinde yalnız yetki anahtarı parolanızla şifrelenir; setleri güvendiğiniz
  bir depoda saklayın.
- **Core'da Enterprise SSO, filo yönetimi ya da merkezi policy servisi yok.**

Açık, denenmemiş ya da kısmi her maddeyi etkisi ve varsa çözüm yoluyla [bilinen sınırlar](docs/known-limits.tr.md) listeler.

## Yol haritası

Beta.1 adayı; abonelikle araçlı sohbet, kodlama işçileri, iş planları ve onay kartları sunan terminale kurulum ve hız
iyileştirmeleri getirir; alpha.64 son yayımlanmış alpha'dır.
Beta boyunca bu özellikler gerçek işlerde iyileştirilecek, sıfırdan kurulum dahil uçtan uca kullanım kontrol edilecek;
sekiz beta kabul koşulunun tamamı hâlâ açıktır.
npm paketi planlanıyor; ayrı ChatGPT tarayıcı girişi işçisi, ortak paket Hub'ı ve native Windows/macOS desteği hazır
sayılmadan önce doğrulanmayı bekliyor.
Masaüstü geliştirmesi planlanan iş koordinasyonu özelliklerine bağlıdır; genel tanıtım proje sahibinin bu uygulamayı
kabul etmesini bekler, ayrı Enterprise sürümü de şirket yönetimi ve ERP bağlayıcılarını getirecektir.

```mermaid
flowchart LR
  N["Şimdi · beta.1 adayı<br/>terminal · onaylar · bütçeler · MCP<br/>/do → kodlama işçileri → Git teslimi<br/>çekirdek katmanlar · kurtarma kartları · imzalı paketler<br/>ChatGPT sohbeti · rehberli kurulum · kaldırma"] --> C["Beta boyunca · gerçek kullanım kabulü<br/>ölçülmüş kurallarla çekirdek katmanları açma<br/>ChatGPT işçi kanıtı · Hub dağıtım kapıları<br/>hafıza · tekrarlanan işten önerilen ajanlar ve yetenekler<br/>işçi yürütme ve atama · değerlendirme<br/>Brain · otomatik kurtarmalı Nervous · Auditor"]
  C --> B["Beta iyileştirmeleri<br/>npm paketi planı<br/>katmanlar gerçek kullanım ve testlerle gelişir<br/>paralelde masaüstü uygulaması geliştirmesi"]
  B --> E["Enterprise · ayrı dağıtım<br/>SSO · filo · merkezi policy<br/>ERP bağlayıcıları"]
```

**Brain** isteği plana çevirir ve sonuçları kabul eder; **Nervous** katmanı çalışan işi izler, iş takıldığında ya da
başarısız olduğunda onu kendiliğinden kurtarır; **Auditor** kabul edileni denetler. Atama her iş türü için işçiyi ve modeli
seçer, değerlendirme sonuçları puanlar, hafıza da öğrenileni bir sonraki işe taşır. Her katman yalnız diğer her şeyle aynı
policy ve onaylar üzerinden hareket eder.

## Daha fazlası

- [Mimariye genel bakış](docs/architecture-overview.tr.md): katmanlar, güvenlik, eklentiler ve bugünkü sınırlar
- [Policy ve AI](docs/policy-and-ai.tr.md): insan ve AI yetkisi, devir, yönetim komutları ve uyum kanıtı
- [Sözlük](docs/glossary.tr.md): kapsam, yürütme ortamı, iş yaşam döngüsü, onay ve harcama
- [Bilinen sınırlar](docs/known-limits.tr.md): denenmemiş, yapılmamış ya da hâlâ açık olanlar; etkisi ve varsa yolu
- [İşletim başvurusu](.deckent/docs/architecture/operator-reference.tr.md): kurulum değerleri, sandbox görünümleri, anahtar
  depoları, harcama, işçi imajları, yama muhafazası ve kurtarma setleri ayrıntılı
- [ARCHITECTURE.md](ARCHITECTURE.md): ayrıntılı mühendislik sözleşmeleri ve uygulama notları
- [CHANGELOG.md](CHANGELOG.md): her beta sürümünün getirdikleri; [CHANGELOG-alpha.md](CHANGELOG-alpha.md): eski alpha sürümleri
- [CONTRIBUTING.md](CONTRIBUTING.md) · [Davranış kuralları](CODE_OF_CONDUCT.md) · [Güvenlik](SECURITY.md)

## Lisans

Apache-2.0 (bkz. [LICENSE](LICENSE)).
