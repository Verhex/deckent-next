# İşletim başvurusu

[README.tr.md](../../../README.tr.md) içindeki ürün özetinin arkasındaki ayrıntılı işletim davranışı. English: [operator-reference.md](operator-reference.md).

Bölümler README'nin sırasını izler: derleme ve ilk kurulum, modeller ve ilk iş, teslim, runtime servisi ve güvenlik,
anahtarlar ve harcama, ardından gündelik terminal ve komut satırı kullanımı. Sondaki [Yöneticiler için iç ayrıntılar](#yöneticiler-için-iç-ayrıntılar)
bölümü muhafaza, işçi imajları, native profiller ve yama işlemeyi anlatır. Her konunun tek
bir bölümü vardır; diğer bölümler ona bağlantı verir.

## Kaynak derleme ve sandbox durumu

- Yeni bir kaynak derlemesi, kilitli bubblewrap'ı (şu an 0.13.0) derleyip yerleştirmek için Docker ister; kilitli kaynağı
  indirir, kaynak ve binary özetlerini doğrular. Doğrulanmış, yerleştirilmiş paket çevrimdışı yeniden kullanılabilir. Sistem
  bubblewrap'ı seçilirse sürümü en az 0.12.0 olmalıdır. Native yalıtım yardımcısı için C derleme araçları gerekir.
- Her `build-bwrap` çalıştırması için yeni bir `--out` dizini kullanın. Build `bubblewrap=present` ya da
  `bubblewrap=staged from …` ile biter. Linux'ta kilitli bubblewrap yerleştirilemezse build bitmez, `BUBBLEWRAP_BUILD_REQUIRED`
  ile durur; Docker'ı başlatıp iki `build-bwrap` komutunu yeni bir `--out` dizinle yeniden çalıştırın ya da
  `DECKENT_BWRAP_BUILD=<doğrulanmış build-bwrap çıktısı> npm run build` kullanın. Yalnız Linux dışında
  `bubblewrap=absent (not Linux)` basar; bu, bubblewrap sandbox'ı olmadığı demektir. Sandbox durumunu `deckent doctor` ile
  inceleyin.
- Hiçbir servis çalışmadan yapılan ilk `doctor` bubblewrap yerine Landlock gösterebilir (`doctor --verbose` nedenini söyler):
  `doctor` yalnız ölçer; paketlenmiş bubblewrap'ı `.deckent/bin` altına runtime servisi, makineyi ölçerken yerleştirir.
  Servisi başlatın (`deckent`) ve `doctor`'ı yeniden çalıştırın.
- **Ubuntu 24.04 ve sonrası.** Çekirdek, bubblewrap'ın ihtiyaç duyduğu ayrıcalıksız kullanıcı ad alanlarını kısıtlayabilir.
  `sysctl kernel.apparmor_restrict_unprivileged_userns` ile bakın: `1` kısıtlı demektir; WSL'de anahtar yoksa (`cannot stat`)
  kısıt yoktur. Deckent o zaman kısıtı bildirir, görünür biçimde Landlock'a düşer ve tam erişimli kabuk çağrılarını reddeder,
  çünkü onlar açık bubblewrap sandbox'ı ister. Bir yönetici bubblewrap'ı root sahipli `/usr/local/bin/bwrap` olarak, ona
  `userns` izni veren bir AppArmor profiliyle kurabilir.
- `npm link`'ten sonra Deckent kaynak dizininin dışındaki kendi proje klasörünüzde çalışın. Uzun ve boşluklu yollar çalışır:
  yerel soket, kuruluma özel kısa ve özel bir dizin kullanır.
- **Platformlar.** Yerel runtime soketi ve doğrulanmış terminal tanığı yalnız Linux'ta (WSL dahil) vardır. macOS'ta runtime
  servisi henüz çalışmaz; bu yüzden sohbet, işler ve yedekleme kullanılamaz. Linux dışındaki her sistemde teslim, dala alma ve
  geri alma `DELIVERY_INTERACTIVE_REQUIRED` ile, ilk kullanım anahtar kartı ve `secret grant` de reddedilir. Native Windows
  desteklenmez ([bilinen sınırlar](../../../docs/known-limits.tr.md)).

## Başlangıç kurulumu

- `deckent init policy --scope <id> --apply` ilk kurulum policy'sini kurar, varsayılan terminal kapsamını
  (`terminal.scopeId`) ve sohbet sınırlarını yazar, iptal ayarlarını ve güncel, boş bir ledger'ı oluşturur. Linux, WSL ve
  macOS'ta yeni kurulum şifreli anahtar deposuyla başlar. Sonraki komutlarda aynı kapsam kimliğini kullanın; mevcut kurulumda
  ayarlarda tanımlı kapsam kimliği geçerlidir.
- **Eski bir kurulumu yükseltme.** Güncel ilk kurulum policy şablonundan (alpha.48'den beri şablon v13) önce kurulmuş bir
  kurulum `deckent init policy --scope <id> --upgrade --preview`, ardından önizlemenin bastığı değerle
  `--apply --expect <değer>` ile yükseltilir. Plan yalnız kural ekler; sizin yazdığınız çakışan kurallar korunur. Değer policy
  revizyonunu ve runtime servis kimliğini bağlar; arada biri değişirse uygulama reddedilir ve yeni önizleme ister. Uygulama
  `service.identity` ayarlarsa yeniden başlatmadan önce [Runtime servisi](#runtime-servisi) bölümüne bakın.
- `deckent init` rehberli kurulumdur: planı ve eksik kalanı, her adımın tam komutuyla gösterir;
  `deckent init --yes --scope <id>` yeni bir ilk kurulum policy'si kurar, dili ayarlar ve son kontrolü çalıştırır.
- `deckent init --preview`, Deckent'in kendi terminal ajanının okuduğu proje talimat dosyası `DECKENT.md`'yi ve
  algıladığı host aracı köprülerini önizler. Docker kodlama işçileri onu okumaz; onlar
  [Kodlama işçisinin talimatları ve keşif](#kodlama-işçisinin-talimatları-ve-keşif) bölümündeki işçi dosyasını alır.
- `deckent doctor` neyin hazır olduğunu söyler, kurulum başlayamıyorsa sıfır dışı kodla çıkar.
  `deckent init preview --profile <dosya>` bir kurulum profili dosyasını önizler (ileri düzey).

## Sağlayıcı bağlantı ayrıntıları

- `/provider` şunları sunar: Anthropic API, OpenAI API, DeepSeek API, Z.ai GLM, Zhipu GLM Çin, OpenRouter, vLLM, Ollama ya da
  LM Studio gibi yerel bir sunucu ve fiyatı yayımlanmış OpenAI uyumlu bir uç nokta. Ücretsiz denemenin reddettiği anahtar asla
  saklanmaz. Ücretsiz denemesi olmayan sağlayıcıda anahtar doğrulanmadan saklanır; olası reddi ilk tur gösterir.
- **Model bağla:** paketlenmiş kataloğu olan sağlayıcılar o modelleri sunar; kataloğu olmayanlarda önce adresi, sonra sınırlı
  `/v1/models` listesinden birebir model kimliğini seçersiniz. Deckent bu kimliği aynen saklar. Yerel loopback modeller
  ücretsiz ölçülür; yayımlanmış fiyatı doğrulanmamış uzak model listelenir ama nedeni ve sonraki adımıyla kilitli kalır (Zhipu
  GLM Çin, fiyatları CNY olduğu için kilitli kalır). OpenRouter model bağlantıları sunar; ücretli çağrı için fiyat ve
  yönlendirme yine doğrulanmalıdır.
- **Komut satırından:** `deckent models connect --scope <id> --connection <tür> --command-id <id> (--model <id> |
  --reference <ref>)` modeli türün paketli kataloğundan bildirir, kapsamın çağrı profilini anahtar adıyla yazar ve
  etkinleştirir. Türler `anthropic-api`, `openai-api`, `deepseek-api`, `zai-api`, `zai-cn-api`, `openrouter`,
  `openai-compatible` ve `local-openai`'dır. `--command-id` sizin seçtiğiniz benzersiz bir addır; onu yinelemek asla iki kez
  bağlamaz. Kişinin terminalinde uzun bayrakları olmadan `models connect`, `models activate|deactivate` ve
  `models catalog activate|deactivate` kapsamı, sağlayıcıyı ya da kanalı ve tam model kimliğini (takma ad asla) sorar, bağ
  özetini ve revizyonları kendisi okur ve kartla onaylatır; yapay zekâ araçları için uzun biçimler değişmedi.
- **Bağlantı türüne göre gizli adlar:** `DECKENT_ANTHROPIC_KEY`, `DECKENT_OPENAI_KEY`, `DECKENT_DEEPSEEK_KEY`,
  `DECKENT_GLM_KEY`, `DECKENT_GLM_CN_KEY` ya da `DECKENT_OPENROUTER_KEY` (`/provider` aynı adla saklar). Yerel sunucu isteğe
  bağlı `DECKENT_LOCAL_ENDPOINT_KEY` adını, OpenAI uyumlu uç nokta ise host'undan türetilen `DECKENT_OAICOMPAT_<HOST>` adını
  kullanır. `--model` birebir API model kimliğini alır; paketlenmiş kataloglar kaynak dizinindeki
  `assets/model-catalog/<bağlantı>.json` dosyalarındadır, terminalde `/model` listeler. Anahtarların nerede tutulduğu ve kimin
  kullanabileceği: [Gizli depolar ve katı kurulum](#gizli-depolar-ve-katı-kurulum).
- **Model seçimi:** `/model`, kullanılamayan modeli nedeniyle kilitler (bütçe yok, bağlı değil, anahtar eksik, etkin değil).
  **Yalnız bu oturum** modeli oturuma sabitler; **Bu oturum ve varsayılanım olsun** ayrıca `terminal.defaultModel` (kullanıcı
  katmanı) yazar. Önce oturum sabitlemesi, sonra varsayılan, sonra projenin adlandırdığı model geçerlidir; pencere kullanılan
  modeli hangi ayarın seçtiğini söyler.
- **Bütçe penceresi:** 5, 10, 25, 50 ya da 100 USD veya ok tuşlarıyla 1 ile 1000 arasında başka bir tam dolar tutarı, ardından
  bir onay adımı; sonra `/provider`'ın ilk satırı **Bütçeyi değiştir** olur. Yerel loopback modeller ve abonelikli işçiler
  (Claude Code, Cursor) bütçesiz çalışır. Sağlayıcı bildirmediyse `/usage` akıl yürütme token'larını *ölçülmedi* gösterir;
  harcama hesabını (üst sınır, ayrılan, kesinleşen) okumak için orada bir bütçe açın. Paranın nasıl ayrılıp kesinleştiği:
  [Harcamanın kesinleşmesi](#harcamanın-kesinleşmesi).
- **Bugün abonelikler:** Claude Code işçisi kendi Claude girişinizle çalışır; abonelikli Brain (`/do`'nun arkasındaki
  planlayıcı) hazırlanıyor ve henüz yok; Claude aboneliğiyle terminal sohbeti şu an desteklenmiyor, sohbet için Anthropic API
  anahtarı kullanın. ChatGPT ile giriş `/provider`'da henüz kullanılamıyor olarak görünür.
- **Cursor işçileri:** paketli Cursor abonelik kataloğunu `deckent models catalog register --scope <id> --command-id <id>
  --seed cursor-cli-subscription` ile kaydedin, sonra modelleri `models catalog activate` ile açın. Bir Cursor denemesi tur,
  token, süre ve araç çağrılarını bildirir ve rapor JSON'u ile biter; gerçekten kullandığı model oturum başlangıç adından okunur
  (`start-name-matched`, `auto` için `provider-chosen`, `substituted` ya da `unverified`). Cursor maliyeti bildirilmez
  (abonelik).
- **Model tabloları:** argümansız `deckent models` kapsamın işçi kataloğunu tek tabloda gösterir (model, kanal, durum, effort;
  emekli model günüyle; `models.retirementWarningDays` içinde, varsayılan 15, emekli olacak açık model için uyarı);
  `--declared` bağlı sağlayıcıların sohbet için bildirdiklerini listeler (`models --declared --json` JSON biçimidir);
  `models --json` katalog incelemesidir.
- **İstem önbelleği:** yeni Anthropic profilleri 5 dakikalık istem önbelleğini kullanır, mevcut profiller yalnız sizin
  seçiminizle değişir; `/usage` canlı hesabı USD olarak, önbellek okuma ve yazmalarını ve tahmini net kazancı gösterir.

## Adım adım ilk iş kurulumu

- **Başlamadan önce:** kurulumunuzda güncel ilk kurulum policy'si olmalıdır; eski bir kurulum önce yükseltilir (bkz.
  [Başlangıç kurulumu](#başlangıç-kurulumu)).
- **İşçi imajı (alpha.54):** `deckent init` işçi imajını kurulu paketten ön planda derler; önce boyutu ve süre sınırını
  (`toolchains.update.buildTimeoutMs`) söyleyen bir kart gösterir ve bu kurulum için bir makbuz kaydeder.
  `deckent init --image-id sha256:<kimlik>` ise bu Docker'da zaten olan bir imajı paketin işçi imaj sürümüyle karşılaştırır
  (ağsız, salt okunur tek kısa konteyner) ve makbuzu kaydeder. Yalnız terminaldeki kişiye sorulur; `--yes` hiçbir zaman
  derlemez. Bu Docker'da zaten bir Deckent işçi imajı varsa yeni derleme ondan sonraki sürümü alır. Sürümler ve güncelleme:
  [Kodlama işçisi imaj sürümleri](#kodlama-işçisi-imaj-sürümleri).
- **`execution` değerleri:** `deckent init` yalnız Docker çalıştırılabilirini, derlediği ya da benimsediği imaj kimliğini ve
  bulduğu Git çalıştırılabilirini yazar; bellek, süreç, CPU, süre, log ve çıktı sınırları varsayılanında kalır
  (`deckent config explain execution`). `deckent doctor` yapılandırılan imajın bu Docker'da olduğunu salt okunur denetler
  (`docker image inspect`, konteyner yok). Ayarı elle kaydetmek şunu basar:
  `execution, proje katmanına kaydedildi. Uygulama: yeniden başlatınca. Yedek: …/.deckent/config.json.bak.<zaman>.…` ve
  `Yeniden başlatma gerekli: çalışan servis önceki yapılandırmayla başladı. `deckent runtime restart` ile (terminalde /service-restart) yeniden başlatın.`
- **Kayıt ve havuz:** `deckent init registry`, bulduğu kodlama CLI'ından ilk kabul kaydını (registry) ve havuz ayarlarını
  yazar. Önizleme CLI'ın tam sürümünü geçici ve ağsız bir konteynerde ölçer, önerilen sürümlü profili ve görev türünü
  gösterir, hiçbir şey yazmaz; uygulama ölçümü tekrarlar ve config policy'si, revizyon kontrolü ve denetim üzerinden yazar.
  Var olan bir kaydın üzerine asla yazılmaz (tipli ret); başka bir tür eklemek için
  `deckent coding template --provider <id> --kind <tür> --preview|--apply` kullanın. Sonucu `deckent config explain admission`
  gösterir. `--discovery`, işçi CLI'ının depodan neyi yükleyebileceğini seçer (bkz.
  [Kodlama işçisinin talimatları ve keşif](#kodlama-işçisinin-talimatları-ve-keşif)). Mevcut bir kurulumda eksik havuz için
  `deckent init pool --scope <id> --preview`, ardından `--apply` çalıştırın; kapasite kabul (admission) yapılandırmasından
  gelir, farklı bir mevcut havuzun üzerine asla yazılmaz.
- **Yeniden başlatma:** `deckent runtime restart` şunu söyler: `Çalışma servisi yeniden başlatıldı (pid …, örnek …).` Yeni bir
  `init policy --apply` servisi zaten adlandırır (`service.identity`) ve onu yalnız kuran kişinin durdurmasına izin verir. Eski
  bir kurulum için [Runtime servisi](#runtime-servisi) bölümüne bakın.
- **Plan kartı:** `/do` kartının Risk ve Geri alma satırları "araç sınıflandırmadı" ve "araç bildirmedi" der; kart
  `approvals.requestTtlMs` (10 dakika) sonra sona erer. `y` sonrası: `Run <run-id> başlatıldı. /tasks veya /monitor ile izleyin.`
  "Başlatıldı" Run'ın başladığı demektir; bir görevin sonucu daha sonra, bugün işçinin çıkış koduyla kabul edilir.
- **Teslim ve dala alma satırları:** `/deliver` "/deliver · teslim bekleyen görevler" başlığını taşır; yamayı güncel kaynakla
  karşılaştırır ve `Teslim edildi: commit <commit> → refs/deckent/deliveries/<özet>` ile biter. Dala alma
  `<commit> commit'i bir dala alınsın mı? Bu dalı ilerletir ve ayrı bir y ister.` diye sorar ve
  `Dala alındı: refs/heads/deckent/first-job <önce> → <sonra>` ile biter; `main` burada checkout edilmişken sunulmaz.
  Checkout'unuz, index'iniz ve çalışma dosyalarınız değişmez. Ayrıntı: [Teslim](#teslim).

## Kodlama işçisinin talimatları ve keşif

Bir kodlama işçisinin deponuz hakkında ne bildiğine birbirinden ayrı iki şey karar verir.

- **İşçi talimat dosyası.** Bir Run iş hedefinden tek bir talimat dosyası iletir; dosya `execution.workerInstructions.source`
  ile seçilir: `worker-md` (`.deckent/worker-instructions.md`, varsa varsayılan olarak kullanılır), `agents-md` (`AGENTS.md`)
  ya da `none`. Git yürütmesi yoksa bu açık bir işlemsizliktir. Yapılandırılmış bir iş hedefi varsa dosya klasörden değil,
  hedefin temel ref'inin gösterdiği commit'ten okunur (alpha.54): commit edilmemiş değişiklik kullanılmaz; bağlantı, alt modül
  ya da ağaç olmayan üst dizin güvensiz diye dışarıda kalır; `status`, güven kartı ve işçi istemi `ref@commit` gösterir.
  Yapılandırılmış hedef yoksa klasördeki dosya okunur. `deckent coding instructions` (ya da `status`) dosyanın yolunu,
  boyutunu, SHA-256 değerini ve işçilerin onu şu an alıp almadığını gösterir. `deckent coding instructions trust|revoke
  [--target <id>] --scope <id>` o klasör için dosyanın tam olarak şu anki içeriğine güvenir ya da güveni geri alır: kendi
  terminalinizdeki kart yolu, boyutu, SHA-256 değerini ve ilk satırları gösterir; yapay zekâ araçları, MCP, borular ve `--json`
  reddedilir; karar `execution.workerInstructions` için config yazma iznini kullanır ve denetim kaydına yazılır. Değişen dosya
  yeniden güvenilmez olur; iş hedefi varsa güven klasöre, ref'e ve içeriğe bağlıdır (aynı baytlı başka bir ref kendi güvenini
  ister; alpha.53'ten kalan klasör ve içerik güveni yine sayılır, sonradan hedef yokken ya da terminalde verilen sayılmaz; ref'teki
  geri alma onu orada bitirir ama klasörün kendi güvenini korur), bu
  yüzden aynı baytlarla ilerleyen dal güvenilir kalır (commit gösterilir ve kaydedilir, karşılaştırılmaz); hedef yoksa güven
  klasöre ve içeriğe bağlıdır. Güvenilene dek işçiler yalnız görev metnini alır ve Run oluşturma `WORKER_INSTRUCTIONS_WITHHELD`
  uyarısı verir; istem sınırlarına sığmayan dosya Run'ı reddeder (`WORKER_INSTRUCTIONS_TOO_LARGE`).
- **Keşif: işçi CLI'ının kendiliğinden yüklediği şeyler.** `disabled` (varsayılan) deponun kendi talimat dosyalarını gizler
  (`AGENTS.md`, `CLAUDE.md`, `.agents`, `.claude`, `.codex`, `.cursor`, `DECKENT.md` ve işçi dosyası): Claude `--safe-mode` ile,
  Codex ön kontrolünün kanıtladığı katı yapılandırma anahtarlarıyla (yalnız Codex 0.163.0'da doğrulandı; Codex güncellenince
  yeniden ölçün) çalışır; böyle bir bayrağı olmayan Cursor ise bu yolları içermeyen seyrek (sparse) bir checkout alır (saklanan
  yama tam checkout'takiyle aynıdır). `repository`, CLI'ın deponun talimat dosyalarını ve yapılandırmasını yüklemesine izin
  verir, depo hook'larını ya da MCP süreçlerini başlatabilir; ek host ya da ağ erişimi vermez. Gizleme bir bağlam önlemidir,
  gizlilik değildir: nesneler klonda kalır ve native araçlar çalışma alanındaki dosyaları yine okuyabilir.
- **Talimat yolları teslimde korunur.** Teslim, görev kapsamı bu talimat yollarını adlandırmadıkça işçinin onlardaki
  değişikliğini reddeder (`PATCH_INSTRUCTION_SURFACE_WRITE`).

Bir profilin keşif ve hook ayarlarını nasıl taşıdığı: [Native kodlama profilleri](#native-kodlama-profilleri).

## Teslim

Teslimin her biri kendi `y`'sini isteyen üç adımı vardır: değişiklik ayrı bir referansa yazılır (teslim), referans izin
verdiğiniz bir dala taşınır (dala alma) ve bir dala alma geri taşınabilir (geri alma). Hiçbiri kendiliğinden olmaz: bir kural
kuyruktaki bir işi teslim *edip etmeyeceğini* kaydeder ama yalnız tavsiye verir.

### Terminalde teslim penceresi

- **Açılış.** Bu terminalin `/do` ile başlattığı bir Run'ın görevi "kabul edildi · yama hazır, teslim bekliyor" durumuna
  gelince teslim penceresi kendiliğinden, girişin odağını almadan açılır (Ctrl+O ya da Aktif iş şeridindeki "teslim bekliyor"
  satırı Ctrl+T ve Enter ile odağı ona verir). `/deliver` kapsamdaki bekleyen tüm görevleri listeler ve seçileni odakla açar.
- **Gösterdikleri.** Önce sade sözlerle bir özet: başlık, neyin değiştiği, neden kabul edildiği (işçinin kendi raporu iddia
  olarak işaretlenir), risk ve evet ya da hayırın ne yapacağı. Ardından görevin Run/Görev kimlikleri, güncel kaynağa karşı uyum
  kontrolü (etkilenen dosyalar tabanla aynı), değişen dosyalar `patch-preview --stat` sayılarıyla, yalnız ayrı bir
  `refs/deckent/deliveries/` referansının yazılacağı (dallar, index ve çalışma ağacı değişmez) ve yalnız
  `execution.adoption.targets` yapılandırılmışsa sonraki ayrı bir seçim olarak hedef dallar.
- **Farkı görmek.** ↑↓/j/k dosya seçer, Enter hunk'ları önizlemenin kurulduğu deneme, taban ve öneri kimliğiyle açar, Esc
  listeye döner. Fark gövdeleri `deliver-port.json` ile sınırlıdır (`maxDiffFiles`, `maxDiffLinesPerFile`,
  `maxDiffBytesPerFile`); ikili ya da aşırı büyük dosya "Gösterilemez: ikili veya çok büyük" der, kesilen satırlar sayılır. Her
  satır pencerenin geri kalanıyla aynı redaksiyon ve terminal metni temizliğinden geçer. Görmek hazırlamaz, teslim etmez, dala
  almaz: fark içinde `y`, `n` ve Enter bir şey yapmaz.
- **Teslim etmek.** `y`, `task integration-check|prepare|deliver` ile aynı uygulamalar ve aşağıdaki onay üzerinden kontrol,
  hazırlık ve teslimi tek akışta yapar: pencerenin `y`'si onayı yalnız kart pencerenin gösterdiği işlem, kimlikler, komut,
  dosya kümesi ve tabanla birebir aynıysa yanıtlar; değilse kartın kendisi gösterilir ve yeni bir `y` ister. Girişe yazılan `y`
  hiçbir zaman onay değildir.
- **Dala almak.** Teslimden sonra yapılandırılmış bir dal yalnız ikinci bir `y` ile dala alınır (↑↓ dalı seçer); `n`/Esc
  hiçbir şey yapmaz. `execution.adoption.verification` yapılandırılmışsa bu `y` önce bir doğrulama adımı açar: kapsamın
  yapılandırılmış türde (tek görevli) kabul edilmiş Run'ları, yalnız doğrulama zorunlu değilse "doğrulamasız dala al" satırı;
  ↑↓ seçer, tek yazılmış `y` seçimle dala alır, `r` listeyi yeniden okur, `n`/Esc geri döner. Hiç yoksa bunu söyler ve
  `deckent run create … --delivery-command-id <bu teslim>` adımını adlandırır. Dala alma, Run'ın tam olarak bu commit'i güncel
  profil ve kurulum ölçütleriyle doğruladığını yine denetler; bir ret nedeniyle seçime döner.
- **Sonuçlar ve retler.** Teslim ve dala alma satırları ile döküm özeti teslim ve dala alma komut kimliklerini gösterir
  (`task integration-rollback --adoption-command-id` için). Eskimiş taban, eksik izin (deneme araması için `scope inspect` ve
  entegrasyon eylemleri) ya da doğrulanmış terminal olmayan bir oturum sade sözlerle ve sonraki adımla reddedilir.

### Teslim onayı

- `task integration-deliver`, `task integration-adopt` ve `task integration-rollback` her biri doğrulanmış bir insan
  terminalinde tek açık `y` ister. Geri alma, dala alınmış dalı geri taşır; bu yüzden dala alma gibi sorar, kartı dalı ve
  şimdiki → önceki commit'i gösterir.
- Kart görev başlığını, Run/Görev kimliklerini, referansı ya da dalı, önceki/yeni commit'i ve değişen dosyaları gösterir. Boş
  yanıt, `n`, girdinin sonu, yönlendirilmiş giriş ya da çıkış ve SDK ya da MCP'den gelen yeni bir etki reddedilir. Hazırlama ve
  kontrol yalnız bir aday kurar.
- Tamamlanmış bir komutun yinelenmesi ya da sonuçlandığı kanıtlanmış bir çökme yeniden sormaz; bitmemiş bir etki yeni onay
  ister.
- Dala alma ayrıca `execution.adoption.targets`, policy, görevin kabulü ve yapılandırılmış doğrulamayı ister; komut satırında
  `--verification-run <run>` verin.
- Teslim commit'leri görev başlığını, kimlikleri ve sınırlı bir kabul durumunu taşır. Yazar ve committer zamanı güvenilir
  teslim planlama saatinden alınır ve yeniden oynatmanın aynı commit'i yazması için teslim niyetinde sabitlenir. Varsayılan
  kimlik Deckent'tir; `execution.git.deliveryIdentity` ile `authorName`/`authorEmail` ayarlanabilir. Önizleme Git nesneleri
  yanıttan önce yalnız adayda hazırlanır; bir ret deponuzda hiçbir Git nesnesi, ref, dal ya da teslim niyeti yazmaz.
- Doğrulanmış terminal tanığı yalnız Linux'ta (WSL dahil) vardır; başka sistemlerde bu komutlar
  `DELIVERY_INTERACTIVE_REQUIRED` ile reddedilir.

### Teslim kuyruğu: inceleme ve geri alma

Kayıtlı bir entegrasyon hedefi servis kuyruğunu kullanır. Kuyruk alpha.43'ten beri Deckent'in kendi geliştirmesinde gerçek
değişiklikleri teslim etti; bu henüz paketlenmiş, barındırılan ya da başka platformlardaki kullanımın kanıtı değildir, bunu
beta göstermelidir. `/deliver` güncel tabanda hazırlar; taban ya da hedef reddinden sonra `r` yeniden hazırlama sunar. Son
bilinen durumu `r` ile okuyun; yayın ve dala alma tam ve sabit partiyi ayrı gösterip ayrı bir `y/N` sorar. `/runs` ayrıntısı
yetkili kapsamın konumunu, sorumluyu ve sonucu gösterir. Main, varsayılan, korunan, checkout edilmiş ve yabancı hedefler izin
listesinde olsalar da reddedilir. Çakışan yollar yeni bir deneme ister; kullanıcı dalına rebase ya da merge yapılmaz.

```sh
deckent task integration-queue-list --scope my-project --json
deckent task integration-queue-inspect --scope my-project --command-id <bilet> --json
deckent task integration-queue-confirm --scope my-project --command-id <bilet>
deckent task integration-queue-rollback --scope my-project --source-command-id <bilet> --command-id undo-1
deckent task integration-queue-confirm --scope my-project --command-id undo-1
```

Geri alma kartı sonuçlanmış tek bir işi kapsar. Bir hata partinin kalanını durdurur ve dala alınmış kısmı korur; belirsiz bir
etki o hedefi uzlaştırılana kadar tutar. Eski doğrudan entegrasyon komutları tarihsel makbuzlarını korur ama etkin bir kuyruk
üzerinden yazamaz. Kuyruk sınırları ve bilet ömrü `targetQueue`'dan gelir; bir doğrulama profili ve policy gerekir. Kuyruk
listesi, inceleme, kuyruğa alma ve geri alma görünümleri ile `/deliver` penceresi teslim özetini değişmeyen onay kartının
üstünde gösterir. Tavsiye veren bir kural (`autonomy@1`) her bilet için `would-deliver` ya da `would-hold` kaydeder ve hiçbir
zaman harekete geçmez ([bilinen sınırlar](../../../docs/known-limits.tr.md)).

Komut satırı çıktısı dala alma adımını henüz "benimseme" diye yazar:

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
- **Yeniden başlatma ve durdurma.** `deckent runtime restart` (ya da terminalde `/service-restart`) servisi yönetilen
  durdurmayla kapatır, güncel derleme ve yapılandırmayla yeniden başlatır; `deckent runtime shutdown` yalnız durdurur (servis
  kimlikleri olmadan `--reason` ister). `deckent runtime describe` çalışanı gösterir. Yeniden başlatma da durdurma da servisin
  kimliğini (`deckent config explain service.identity`) ve sizin o servis üzerindeki `shutdown` kuralınızı ister; ilk kurulum
  policy'si bunu yalnız kuran kişiye verir. Yerel MCP aktörü varsayılan olarak servisi durduramaz (ona `service` MCP grubunu
  veren bir policy durdurabilir).
- **Eski kurulumlar.** Şablon v12'den eski bir ilk kurulum policy'sinde ne servis kimliği ne de `shutdown` kuralı vardır; bu
  yüzden `runtime restart` ve `runtime shutdown` reddedilir. Policy'yi yükseltin (bkz. [Başlangıç kurulumu](#başlangıç-kurulumu));
  uygulama `service.identity` ayarlarsa çalışan servisi bir kez elle durdurun (`runtime serve` üzerinde Ctrl+C), sonra
  `runtime restart` çalışır.

## Sandbox görünümleri

- Standart, dikkatli ve tam otomatik modlarda sandbox'taki kabuk komutu **kapalı bir görünüm** alır: proje, çağrının onay
  kuralları içinde yazılabilir; `.git` salt okunur, ev klasörü gizli ve ağ kapalıdır. Onaylanan komutlar da Deckent'in yetki
  dosyalarına yazamaz. Landlock ayrıca izin ve sahiplik değişikliklerini reddeder ve korunan yolları tutan dizinlerde giriş
  ekleyip silemez.
- Tam erişim, kullanılabilir bir **açık bubblewrap sandbox'ı** ister: ağ ve ev klasörü açılır; Deckent durumu, ayarlar, kimlik
  bilgisi kalıpları ve host Docker/oturum D-Bus soketleri maskeli ya da salt okunur kalır. Açık sandbox yoksa tam erişim kabuk
  çağrıları, açıkça `host` seçilmiş olsa bile reddedilir.
- **Host'a düşme.** Sandbox yoksa kapalı bir mod host'a düşer ve bunu söyler (`terminal.shell.realm`, varsayılan
  `prefer-sandbox`); bu yolun dosya sistemi sınırı yoktur, bu yüzden yalıtım şartsa `require-sandbox` seçin.
- **MCP sunucuları** varsayılan olarak ağ erişimi ve kendi kalıcı ev klasörü olan bir sandbox'ta (`sandbox-net`) çalışır; kaydı
  `host` diyen bir sunucu sandbox'sız çalışır, her birinin nerede çalıştığını `/mcp` gösterir.
- Ortak kimlik bilgisi kataloğu gh, Docker, kube, Codex, Git kimlik bilgileri ve yaygın bulut CLI'larını kapsar. Ev klasörü
  maskelemesi sınırlıdır (3 derinlik, 20.000 giriş); özel konumlar, farklı dosya adları ve maskelerin dışındaki takma yollar
  ayrıca yalıtılmalıdır.
- Tam otomatik `find -delete`, dosya kısaltma (`>`, `>|`) ve taşıma (`mv`) için yine sorar; ekleme (`>>`) değişiklik sayılır.
- Sabit zemin (Deckent ayarları, policy, onaylar, denetim, sırlar ve MCP kayıt defteri) her sandbox modunda uygulanır.

## İzin modları

Tam otomatik ve tam erişim, kurulum sahibi bir kapsam için `deckent init policy --scope <id> --modes <liste>|none
--preview|--apply` ile açana dek kapalı kalır (`<liste>`: `full-auto`, `full-access` ya da ikisi, virgülle; `none` ikisini
kapatır; `--expect <rev>` eşzamanlı değişikliğe karşı korur). Uygulama, önizlenen revizyon üzerinde sahibin kendi
terminalinde bir y/N kartı sorar ve denetime yazılır; yapay zekâ araçları, borular ve CI bunu çalıştıramaz. Yeni bir ilk
kurulum policy'si hiçbir modu açmaz. `--modes none` sonrasında bir sonraki çağrıda mod artık yoktur; kayıtlı seçim kalır ve
terminal iznin verilmediğini söyler. Sözleşme: [sahibin açtığı modlar](modules/permission-modes.md#pre-9-solo-mod-izni-alpha51).

## Gizli depolar ve katı kurulum

| Depo (`secrets.store`) | Diskte | Anahtarı kim okuyabilir |
|---|---|---|
| `core.secret-store.env@1` (hiçbir depo seçilmemişse) | hiçbir şey; ortam değişkeninden okunur | o ortamı devralan her program |
| `core.secret-store.file@1` | düz metin, 0600 dosya | Deckent ve sizin hesabınızla çalışan diğer programlar |
| `core.secret-store.encrypted-file@1` (önerilen; yeni kurulumlar bununla başlar) | şifreli (AES-256-GCM); açma anahtarı aynı klasörde, parola yok | Deckent; sizin hesabınızla çalışan diğer programlar yine açabilir |

Sağlayıcı çağrıları anahtarı runtime'ın içinde çözer; anahtar isteme ya da shell ortamına konmaz ve işçiler asla anahtar
almaz. Desteklenen sandbox görünümleri depoyu gizler; host realm'i ya da host'a düşen yol dosya sistemi yalıtımı sağlamaz.
Saklı anahtarı geri yansıtan sağlayıcı yanıtı reddedilir. `deckent doctor` etkin depoyu adlandırır, depo listesi başarısız
olursa `unverified` gösterir ve buradaki bir modelin kullanamadığı anahtarları tam sonraki komutla adlandırır;
`deckent doctor --verbose` depoyu kimin okuyabileceğini de söyler. Sağlayıcı anahtarı reddederse (401/403) ya da bir sınır
dolarsa terminal bunu açık sözlerle söyler.

**Katı kurulum**, anahtarı makinedeki başka hiçbir programın okumaması gerekiyorsa. Yeni Linux/WSL/macOS kurulumları, kurulu
policy geçişe izin veriyorsa şifreli depoyu `init policy --apply` ve Docker `init apply` ile seçer; mevcut kurulumlar
seçimlerini korur.

1. Anahtarlarınızı şifreli depoya taşıyın: `deckent secret store` kayıtlı depoları seçmeniz için listeler; env deposundan
   çıkarken hedefte eksik olan yapılandırma başvuru adlarını listeler ve evet/hayır sorar (betikler `--confirm-env-missing`
   ister); `doctor` aynı adları gösterir. Komut her anahtarı kopyalar, doğrular, yeni depoyu seçer ve ardından eski kopyayı
   siler; daha zayıf bir depoya geçiş ikinci bir uyarı kartında onay ister. Kaydetme, silme ve geçiş tek bir kurulum geneli
   muhafaza bölümünü paylaşır.
2. Diğer yapay zekâ araçlarını Deckent'in durum klasöründen uzak tutun; örneğin Claude Code'un `~/.claude/settings.json`
   dosyasında depo dosyaları için `Read` yasak kuralları. Bu, dosya araçlarını ve yaygın shell komutlarını durdurur, her betiği
   değil.
3. Planlanan: Deckent servisini ayrı bir işletim sistemi kullanıcısında (ya da macOS Keychain ile) çalıştırmak; böylece
   hesabınızdaki hiçbir program anahtarları okuyamaz.

Dosya depoları native Windows'ta yok.

### Proje anahtar kasası

- **İki tür kasa.** Ana kasa, yukarıdaki kurulum deposudur. Proje kasası, tek bir proje klasörüne ait şifreli bir depodur.
- **Anahtar kaydetmek.** `deckent secret set AD --main|--project` değeri yalnız kişinin kendi terminalindeki gizli istemden
  alır. Borudan, betikten, ajandan ya da CI'dan gelirse stdin okunmadan reddedilir (`SECRET_SET_TERMINAL_REQUIRED`).
  `--main`/`--project` verilmeyen bir terminal hangi kasa olduğunu kartla sorar; `--json` ile verilmezse
  `SECRET_VAULT_REQUIRED` döner.
- **`.deck` dosyası.** Proje kendi anahtarını yalnız `.deck` dosyası `AD=project` bildirdiğinde, ana kasa anahtarını ise yalnız
  izinden sonra kullanır. `.deck` değer değil yalnız referans tutar, bu yüzden depoya eklenebilir: ilk kayıt `DECK_FORMAT=1`,
  ardından her satırda bir `AD=main` ya da `AD=project` (`#` yorumları ve boş satırlar serbest; en çok 64 KiB ve 256 kayıt);
  başka her satır dosyanın tamamını reddeder (`DECK_FILE_INVALID`, yalnız satır numarasını söyler).
- **İzinler.** İzin, kişinin kendi terminalindeki bir karttır: solo terminal sohbetindeki ilk kullanım kartı ya da
  `deckent secret grant AD --scope S`; `secret revoke AD --scope S` izni geri alır, yapay zekâ oturumları izin veremez. İkisi de
  Linux terminal tanığını ister.
- **Taşıma ve listeleme.** `secret handover --scope S`, proje klasörü taşındığında anahtar kasasını da götürür (özgün klasör
  kasayı hâlâ tutuyorsa reddedilir). `secret list` ad · kasa · proje · kullanan · `.deck` · izin · saklı bilgisini gösterir,
  değeri asla; `--all` bu ana kasanın tüm proje kasalarını listeler.

Sözleşme: [proje anahtar kasası](modules/permission-modes.md#pre-8-project-key-vault-alpha51).

## Harcamanın kesinleşmesi

Her kapsamın tüm API sağlayıcıları için ortak tek bir USD bütçesi vardır. Ücretli bir çağrıdan önce Deckent, geçerli olabilecek
en pahalı fiyat kademesinde çağrının tutabileceği en yüksek tutarı ayırır; sonra çağrıyı sağlayıcının son yanıtında bildirdiği
kullanım ile doğrulanmış yayımlanmış fiyatın çarpımından kesinleştirir (`measured-tariff`). OpenRouter çağrıları istisnadır:
OpenRouter'ın yanıtında bildirdiği ücretten kesinleşir. Sağlayıcı hangi fiyat kademesini kullandığını söylemiyorsa (DeepSeek)
çağrı yayımlanmış en yüksek fiyattan kesinleşir ve üst sınır olarak işaretlenir. İlk ücretli OpenRouter çağrısından önce
https://openrouter.ai/settings/plugins sayfasında hiçbir eklentinin "Prevent overrides" ile açık olmadığını kontrol edin ve
OpenRouter kredi sınırını Deckent bütçenizden yüksek olmayacak şekilde ayarlayın; Deckent bu iki ayarı göremez.

- Kapsamın ilk bütçesi `deckent models create-budget --scope <id> --usd <n>` ile ya da bütçe penceresiyle (`/provider`'ın ilk
  satırı) açılır, `deckent models revise-budget --scope <id> --usd <n>` ile değişir.
- Son kullanımını hiç almamış bir çağrı, siz `deckent models reconcile-spending` ile çözene kadar ayrılmış kalır.
- Bir tutar ayrılandan fazla çıkarsa kapsam yeni ücretli çağrıları `revise-budget … --unfreeze` yapılana kadar durdurur.
- `--input` olmadan `deckent models spending` kapsamın API bütçesini (sınır, kullanılan, ayrılan, kalan) gösterir.

## Terminal penceresi ve tuşlar

- **Düzen.** Etkileşimli terminal tam penceredir (terminalin alternatif ekranı, Claude Code tam ekran görünümü gibi): sohbet
  üst alanda kayar, giriş barı oturum boyunca aynı alt satırda kalır (yalnız pencere boyutu ya da kendi çok satırlı taslağınız
  onu oynatır), altında sabit bir bilgi alanı durumu, modeli ve modu, Aktif iş özetini (ya da tam erişim satırını) ve tuş
  ipuçlarını gösterir. Bilgi satırı sohbetin bağlam kullanımını da gösterir (`/context` ölçümü; ilkinden önce "bağlam ?").
  `terminal.layout: inline` önceki satır içi düzeni korur (çalışırken yerel kaydırma geçmişi; ekran okuyucuyla önerilir).
- **Kaydırma ve arama.** Sohbet en yeni satırı izler; fare tekerleği her çentikte üç satır, PgUp/PgDn yarım görünüm kaydırır,
  Ctrl+Home ilk satıra, Ctrl+End en yeniye döner. Geriye okurken bir satır kaç yeni mesaj (ya da satır) geldiğini söyler ve
  End/Home en yeniye/ilk satıra atlar (akış görünümü aşağı çekmez; en altta yeniden izler). Geride okurken Ctrl+F bu görünümün
  tuttuğu sohbette arar (yalnız gösterilen, maskelenmiş metin; Enter/↑ eski, ↓ yeni, Esc kapatır; taslak değişmez),
  Ctrl+Yukarı/Ctrl+Aşağı önceki/sonraki mesajınıza atlar (Ctrl+R giriş geçmişi aramasıdır). `terminal.viewportRows`
  (varsayılan 2000) görünümün ne kadar geriye kaydığını sınırlar.
- **Çıkış ve seçim.** Çıkışta sohbet normal ekrana yazılır, böylece terminalin kaydırma geçmişinde kalır; `/clear` görünümü ve
  o geçmişi boşaltır. Tam pencere yalnız gösterilirken fare tekerleğini alır (tıklamalar yok sayılır ve hiçbir kartı
  yanıtlamaz); metni Claude Code'daki gibi terminalin değiştirici tuşuyla seçin — çoğu terminalde Shift, iTerm2'de Option,
  Terminal.app'te Fn.
- **Slash komutu pencereleri ve odak.** Slash komutu pencereleri ve kartlar giriş barının hemen üstünde açılır, ekranın en çok
  yarısını kaplar ve içeride kayar (oklar, PageUp/PageDown ve Home/End; satır aralığı görünür); sohbet alanını daraltır, barı
  oynatmaz. Komutunuzla ya da seçiminizle açılan pencere hemen odağı alır; Escape kapatıp girişe döner. Otomatik /do planlama
  ve ilerleme pencereleri ile Run/işçi izlemeleri giriş odağını almaz: taslak yazabilir, Enter ile mevcut işlemin arkasına
  sıraya alabilirsiniz. Ctrl+O giriş ile üst pencere arasında odağı değiştirir. `/watch-stop` gözlemi kapatır.
- **Onay kartları.** Onay kartı (ve her soru) klavyeyi kendiliğinden alır ve giriş barının yerine geçer; Ctrl+O gerekmez.
  Yanıtları bir listedir — "Evet, bu sefer (y)", "Evet, bu oturum boyunca (s)" ve "Bu projede hep izin ver (a)" yalnız servis
  sunduğunda (sabit zemin öğelerinde ve her zaman sorulan kilitlerde asla), "Hayır (n)" — ↑↓, j/k ya da 1–9 ile seçilir, Enter
  ile onaylanır ya da harfle yanıtlanır; seçim Hayır'da başlar, Esc reddeder. "Hep izin ver" sizin kalıcı izninizdir
  (`deckent policy grants --mine`, `deckent policy revoke` ile kaldırılır). Bekleyen birden çok karar tek tek gelir ("1/3").
- **Kartlarda tuş güvenliği.** Kart, gösterildiği andan itibaren kısa bir sessiz süre (0,3 sn, `decision.json`) geçmeden tuş
  saymaz; o sırada ipucu satırı "Yeni açıldı · tuşları birazdan çalışır" der (erken gelen tuş için "Tuş sayılmadı … yeniden
  basın"). Girişe az önce yazılan tuşlar, basılı tutulan tuş, yapıştırma, az önce yanıtlanan karttan ya da odak değişiminden
  gelen tuş kartı yanıtlamaz; birden çok tuş olayı üreten tek bir okuma asla karar vermez. Taslak korunur ve barla geri gelir.
- **Taslaklar.** Çok satırlı taslak, yükseklik bütçesi içinde imleci izler. Ctrl+S taslağın tamamını kenara koyar (yalnız
  bellekte; kaydedilmez, loglanmaz), boş satırda geri getirir (kenardaki taslağın üzerine asla yazılmaz); Ctrl+_ gönderilmemiş
  son düzenlemeyi geri alır (kesintisiz yazım tek adımdır, gönderince silinir). Girişteyken Escape taslak/iptal davranışını
  korur.
- **Aktif iş.** Girişin altındaki "Aktif iş" satırı bu oturumun çalışan /do'sunu (planlanıyor ya da kalan onay süresiyle sizi
  bekliyor) ve başlattığı Run'ları başlık, durum, geçen süre ve "+N daha" ile gösterir; kendiliğinden odak almaz. Ctrl+T tam
  listeyi girişin üstünde açar (↑↓, Esc geri): /do üzerinde Enter penceresine odaklar, Run üzerinde Enter o Run'ın penceresini
  açar; biten Run açıldıktan sonra şeritten çıkar.
- **Mod renkleri.** Standart soluk, tam otomatik kendi renginde, tam erişim uyarı tonunda sakin bir `⏵⏵⏵` işaretiyle
  gösterilir (NO_COLOR ile modu sözcükler taşır). Boru ve satır modu çıktısı değişmez.

## Run'lar, görevler ve onaylar

### Terminalde Run denetimleri

`/runs` kapsamın Run'larını seçimli listeler. `h` bitmemiş, iptal edilmeyen ve zaten bekletilmeyen bir Run'ı bekletir, `r`
operatör bekletmesiyle ya da başarısız bir ilerlemeyle park edilmiş bir Run'ı sürdürür (soru, karar ya da kota beklemesi
sürdürmeyle kalkmaz; orada `r` sunulmaz), `c` park edilmiş bir Run'ı kapatır; ipucu satırı yalnız seçili Run'ın durumunun
sunduğu tuşları adlandırır. Her tuş Run'ı yeniden okur ve denetimin ne yaptığını, durumu ve gönderilecek revizyonu gösteren
bir y/N kartı açar; yalnız tek yazılmış `y` gönderir (Ctrl/Alt bileşimleri, yapıştırılmış ya da birleşmiş tuşlar asla; `n`,
Enter, Esc ve Ctrl+C Run'ı korur). Bekletme gerekçenizi (Tab) ya da varsayılan bir cümleyi not olarak alır. Denetim, gösterilen
revizyona karşı CLI'ın kendi `run hold|resume|close` komutudur; policy (bekletme ve kapatma için `run cancel`, sürdürme için
`run reserve`) ve Run'ın durumu karar verir, ret listenin üstünde tipli neden olarak görünür. Sonuç satırı Run'ın yeni durumunu
ve komut kimliğini adlandırır. Bekletme yeni rezervasyonları durdurur; zaten çalışan iş sürer. Bir görevin sorusunu yanıtlamak
ve görevi kabul ya da reddetmek ayrı kararlardır, buradaki tuşlar değildir.

### Görev ve Run komutları

- **Dil ve kısa kimlikler.** Her `task` ve `run` görünümü çağrının dilini kullanır (`--lang`, sonra `DECKENT_LANGUAGE`, sonra
  config `language`, sonra sistem dili). `--run` (ve var olan bir Run'ı adlandıran her `run` eylemi) kısa kimlik alır: tam
  kimlik ya da `/runs` listesindeki bir Run'ın benzersiz öneki; birden çok aday `CLI_ID_AMBIGUOUS` (çıkış 2) olur; başka her
  değer olduğu gibi iletilir. `run create --id` hiç çözülmez; yeni Run'ın adıdır.
- **Kapsam.** `--scope` olmayan bir okuma yapılandırılmış `terminal.scopeId`'yi kullanır ve ilk satırda söyler; yoksa terminal
  dışında geçerli kapsamları sayan `CLI_SCOPE_REQUIRED` döner.
- **`deckent run list`**, `/runs` ile aynı Run'ları her birini aynı inceleme uygulamasıyla okur: önce bekleyen (park edilmiş)
  Run'lar, sonra en yenisi; kısa kimlik, `/runs` durum sözcükleri, kabul edilen görevler ve başlıkla. `--json` Run
  görünümlerini döndürür.
- **`run inspect`** isteği, sonucu ve görevleri okur (her görevde kabul edilmiş sonucun neye dayandığı, ör. "kabul: çıkış kodu ·
  içerik bağımsız doğrulanmadı", sonra teslim); yetki kaydı, maliyet özeti, kabul meta satırı, profil ve ölçüt satırları, tam
  kimlikler ve beş yoldan uzun gizli bilgi kapısı listesi `--verbose` ile gelir. `task inspect` aynı sırayla okunur; daha uzun
  bir gizli bilgi kapısı listesi, yasak listesinin istisnalarını adlandıran tek bir satırdır.
- **Kişinin terminalinde** kimliksiz `run inspect` ve `report` Run'ı seçtirir; `--command-id`/`--expected-revision` olmadan
  `run cancel|hold|resume|close` kapsamı (bir değişiklik varsayılanı sessizce almaz) ve Run'ı (yalnız durumu o denetimi sunan
  Run'lar) seçtirir, revizyonu kapsamı, Run'ı, durumu ve sonucu adlandıran kartın hemen öncesinde okur ve sistemin ürettiği
  komut kimliğiyle gönderir; `n`, Esc ya da sessizlik hiçbir şey göndermez, arada değişen Run yeniden okunup yeniden sorulur.
  `--run`/`--task` verilmeyen `task inspect|transcript|patch-preview` kapsam, Run ve görev seçtirir.
- **Argümansız `deckent task`** görevin yalnız geçerli eylemlerinin menüsünü açar: deneme varsa inceleme, döküm ve fark; karar
  açıkken kabul/ret; teslim bekleyen kabul edilmiş yama için teslim. Kabul ve ret revizyonu kartlarından hemen önce okur ve
  komut kimliğini üretir; bu arada değişen Run reddedilir (`RUN_STORE_CONFLICT`), yeniden okunur ve yeniden sorulur. Teslim
  `/deliver` ile aynı uygulamaları kullanır; her yazma (aday ve teslim, dala alma, kuyruk partisi) kendi birebir kartını bekler;
  yalnız Enter, Esc ya da sessizlik (oturum onay süresi) hayır demektir.
- **Borular, yapay zekâ ajanları, CI ve `--json`** hiçbir zaman sorulmaz: tüm yazılı bayraklar zorunlu kalır; argümansız
  `deckent task` eksik argümanı adlandırır ve eylemleri dört grupta listeler (İncele, Yürüt ve değerlendir, Teslim, Kuyruk),
  çıkış 2.
- **`patch-preview`** biçimini korur; kontrol karakterleri etkisizleştirilen bir fark satırının ardından
  `\ üstteki satırdaki kontrol karakterleri etkisizleştirildi` satırı gelir (`--stat` ve `--json` değişmez).
- **`deckent report`** Bilinen (sonuç, kabulün dayandığı kanıt, okunur birimlerle süre, CPU, bellek, model) ve Ölçülemeyen (her
  alan nedeniyle, ör. abonelik çağrısında çağrı başına ücret yoktur) bölümlerini gösterir; `--run` yoksa kapsamın son
  Run'larını listeler.
- **`deckent inventory`** bu kurulumun dağıtım günlüğünün geliştirici görünümüdür (kısa kimlik, `--verbose` ile tam kimlik);
  `workers list` yapılandırılmış `inspection.workers.sources` kaynaklarını da okuduğu için daha çok kayıt gösterebilir.
  `inspection.maxPageSize` üstündeki bir sayfa, en büyük değeri söyleyen `DISPATCH_INVENTORY_LIMIT` olur.

### CLI'dan onaylar ve kararlar

- **Listeleme.** `deckent approval list` (ve argümansız `deckent approval`) varsayılan kapsamı okur, adını ilk satırda yazar
  (`--scope` değiştirir): önce kalan süreyle bekleyen onaylar ("8 dk kaldı"), sonra diğerleri en yenisi önce; en çok
  `approval.json` sayfa ve satır sınırı kadar, sessiz kesme yerine "daha fazla"/"taranmadı" satırlarıyla; `--json` ham sayfadır.
- **Yanıtlama.** Kişinin terminalinde bekleyen bir onay seçilip terminalin kartında yanıtlanır: bir kez ya da hayır. Saklanan
  bir onayın çalışan turu yoktur; bu yüzden ona "bu oturum" ya da "her zaman" sunulmaz; sabit zemin isteği yalnız bir kez izin
  verilebileceğini söyler. Revizyon ve komut kimliği sistemden gelir, kanal `local-cli`'dır, gerekçe sizin `--reason` değeriniz
  ya da varsayılan "Terminalde onaylandı"dır. İptal edilen ya da sessiz kalan kart karar vermez; karar her onay gibi aynı
  runtime denetiminden (doğrulanmış terminal, en düşük güvence) geçer. `--input` olmadan `approval decide` terminalde aynı
  seçimdir, başka her yerde eksik `--input` adını söyler.
- **Yapay zekâ araçları için** JSON yolu (`--input`) değişmedi. Girdi önce uygulamanın şemasıyla denetlenir; yanlış alan adıyla
  söylenir (`CLI_INPUT_FIELD_INVALID`, çıkış 2, örnekle); gerekçesiz karar hiçbir şey gönderilmeden reddedilir; sonuçlar okunur
  metindir, ham JSON yalnız `--json` ile; `--schema` girdi sözleşmesini basar.
- **Kararlar.** Eylemsiz `deckent decide` kapsamın son kararlarını listeler; karar portunun `inspect` iznini ister, ilk kurulum
  policy şablonu bunu v13'ten beri verir (eski bir kurulum yükseltmeyle alır). Terminalde bir karar seçenekleri, tavsiye,
  seçim ve sonuçla bir pencerede açılır. `decide <eylem> --schema` ve alan adlı girdi hataları `approval` gibi çalışır. MCP'de
  henüz karar aracı yok.

## Yönetim komutları

- **Argümansız okumalar.** Eylemsiz `deckent pool`, `audit`, `secret`, `runtime`, `backup` ve `toolchains` okur: havuzun durumu
  ve kapasitesi, son checkpoint ile denetim sonucu, anahtarlar (ad · kullanan · depo, değer asla), servis durumu (derleme,
  yapılandırma, çalışan işler, soket; başlangıç zamanı bir sonraki protokol sürümüne kadar yok), kurtarma setleri
  (`state/backups/recovery`: tarih · boyut · tür · son doğrulama · ad) ve araç tablosu (ağ kullanımı önce yazılır).
  `deckent paths` yerleşimi var/yok bilgisiyle gruplar ve gerçekte kullanılan soketi (`/tmp/dk-<uid>-<sha256>/s`) adlandırır.
  Boruda çıktı metindir; JSON yalnız `--json` ile, aynı sözleşmelerle.
- **Değişiklikler.** `deckent pool hold|resume` bir havuzu durdurur ya da sürdürür. Bir değişiklik sessiz kapsam almaz:
  terminal dışında `pool hold|resume|set-capacity|quota-release`, `secret set|delete|store --to` ve `backup create|restore`
  `--scope` ister. Kişinin terminalinde kapsam, set, anahtar ya da depo seçilir ve değişiklik önce bir kartta onaylanır (yapay
  zekâya, CI'a ya da boruya asla sorulmaz): geri yükleme hedefi, servis durumunu ve değiştirilen dosyaların nerede saklandığını
  gösterir, `toolchains update` derlemeden önce planı gösterir, `audit rebaseline` kartla onaylanır. Anahtar kuralları:
  [Proje anahtar kasası](#proje-anahtar-kasası).

## MCP ve kimlik

- **Deckent'in ajanı için MCP sunucuları.** `deckent mcp` / `mcp list` bir tablodur (bekleyenler önce, sonraki adımlarıyla) ve
  hiçbir şeyi başlatmaz; `--check` yalnız güvenilen sunucuları başlatır. Her güven kararı (`mcp approve`, yerel ya da kullanıcı
  kapsamına `mcp add`) kişinin terminalindeki bir karttır; terminal dışında reddedilir (`MCP_APPROVAL_NEEDS_TERMINAL`) ve `--yes`
  kartı atlamaz. Sunucuların nerede çalıştığı: [Sandbox görünümleri](#sandbox-görünümleri).
- **Dışarıdaki yapay zekâ istemcileri için izin grupları.** `/policy` (**MCP izinleri**) penceresinde havuz yönetimi, katalog
  kaydı ve genel model yapılandırması **tüm kapsamlar** olarak gösterilir. Bir grubun iznini kaldırmak başka izinleri silmez;
  araç o izinlerle açık kalabilir. "Dogfood çalışanı" yalnız iş izinlerini içeren önerilmiş bir hazır ayardır; gerçekte hangi
  araçlara ihtiyaç duyduğu henüz doğrulanmadı. Kaldırma, verme ile aynı iki adımı kullanır
  (`deckent policy mcp revoke … --preview`, sonra `--apply --expect <özet>`).
- **Kimlik.** Argümansız `deckent identity` seçili kimlik profilini — ya da `deckent config set identity.profile` ile nasıl
  seçileceğini —, kişileri ve rol bağlamalarını söyler; `identity profiles` profilleri listeler; profil seçilmemişken
  `identity preview` `IDENTITY_PROFILE_NOT_SELECTED` bildirir; terminalde `identity distribute --scope <id> [--apply]` ok tuşlu
  kartlarla ve bir önizleme kartıyla seçilir.

## Kurulum kurtarma setleri

`deckent backup create|verify|restore` tek bir yönetilen sözleşmeyi kullanır. Kurulum sahibinin kurulum geneli `backup` policy
iznine ihtiyacı vardır; eski bir kurulum bunu policy yükseltmesiyle alır ([Başlangıç kurulumu](#başlangıç-kurulumu)).

```sh
deckent backup create --scope <id> --set /private/recovery/set-1
deckent backup verify --scope <id> --set /private/recovery/set-1
deckent backup restore --scope <id> --set /private/recovery/set-1 --target /private/new-install
```

**Set neyi tutar.** Çevrimiçi ledger kopyasını, parmak izini, manifest'i, küçük durum arşivini ve şifreli yetki anahtarını.
Proje ve genel yapılandırma katmanları ayrı arşivlenir. İşçi klonları, sağlayıcı oturumları ve gizli depo kimlik bilgileri
dışarıda kalır. Set dosyaları 0700 dizinde 0600'dür; sette `ledger.db-wal/-shm` kalmaz. Parolanızla yalnız yetki anahtarı
şifrelenir; ledger ve durum arşivi düz dosyadır, bu yüzden setleri güvendiğiniz bir depoda saklayın (setin tamamının
şifrelenmesi henüz yok).

**Parola ve bütünlük.** Parola maskeli bir terminal isteminden ya da stdin'den okunur; parola argümanı yoktur. Parolayı setten
ayrı saklayın. Manifest'teki dosya özetleri parolayla mühürlenen anahtar zarfına bağlıdır; bu yüzden bir dosyayı değiştirip
özetini yeniden yazmak da yakalanır: `BACKUP_PASSPHRASE_INVALID` yanlış parola ya da değiştirilmiş set demektir. Şifre
çözmeden önce verify ve restore diğer nedenleri kendi kodlarıyla söyler (çıkış 78): `BACKUP_SET_NOT_FOUND` (yolda
`MANIFEST.sha256` içeren klasör yok), `BACKUP_SET_UNREADABLE` (bu kullanıcı seti okuyamıyor), `BACKUP_PASSPHRASE_REQUIRED` (boş
parola) ve `BACKUP_MANIFEST_INVALID` (bir dosya manifest'le eşleşmiyor: set değiştirilmiş). Var olmayan bir setin geri
yüklenmesi, setin yanında tutulan kurtarma denetimi yazılmadan reddedilir; yanlış yazılmış bir yolda denetim klasörü oluşmaz.

**Geri yükleme.**

- Önce hedef servisi durdurun; geri yükleme yalnız servis durmuşken çalışır. Boş hedef değiştirme onayı istemez; dolu hedef
  için `--confirm-target /tam/mutlak/hedef` ekleyin. Başka bir kuruluma bağlı hedef reddedilir. Mevcut bir kurulumda geri
  yüklemeyi o kurulumun proje kökünden çalıştırın; yapılandırılmış yerleşimi uyumsuz farklı bir hedef reddedilir. Eski durum
  `.damaged-<uuid>` kopyalarında korunur.
- Taşınan kimlik bildirilir, installationId korunur; `deckent init identity --keep` operatörün açık onayını ister. Kurulum
  içindeki yapılandırma yolları yeniden yazılır; dış yollar dışarıda kalır. Geri yükleme zamanlamayı kapatır. Servisi açmadan
  önce dışarıda kalan kimlik bilgilerini yeniden sağlayın.
- Proje katmanı proje yapılandırması olur. Genel yapılandırma (`$DECKENT_GLOBAL_HOME/config.json`) kurulumlarınızca paylaşılır:
  geri yükleme yalnız onda olmayan arşiv bölümlerini ekler (ör. makine kaybından sonra `secrets` depo seçimi) ve var olanları
  korur (sonuçta `globalConfig.added` / `kept`). Korunan genel katman başka bir onay anahtarı dosyası gösteriyorsa geri yüklenen
  proje yapılandırması setin anahtarını gösterir (`changedPaths` içinde `/approvals/keyFile`); genel dosyanız değişmez. Korunan
  bir genel bölüm geri yüklenen proje yapılandırmasıyla kullanılamıyorsa geri yükleme hiçbir iş yapmadan dosyayı ve bölümü
  adıyla `BACKUP_TARGET_CONFIG_CONFLICT` ile durur: o bölümü uyumlu hâle getirin ya da kaldırın, sonra yeniden çalıştırın.
  alpha.18 ile alınmış bir set tek birleşik belge taşır; onun `secrets` seçimi proje yapılandırmasına değil genel katmana gider.
- Geri yükleme var olan bir dizine yalnız sizinse ve başkaları yazamıyorsa yazar (0755 bir `.deckent` uygundur; `doctor` modunu
  yine gösterir). Aksi halde hiçbir iş yapmadan dizini adıyla `BACKUP_DIRECTORY_UNSAFE` ile durur: `chmod 700 <yol>` çalıştırıp
  yeniden deneyin. Hasarlı bir policy dosyası geri yüklemeyi `BACKUP_POLICY_UNREADABLE` ile durdurur: adı verilen dosyayı
  kenara taşıyın (`mv <yol> <yol>.damaged`) ve yeniden çalıştırın; geri yükleme o zaman setin doğrulanmış policy'sini kullanır.
- Aynı projeye geri yükleme mevcut kaynak yerleşimini korur: her kaynak güncel yapılandırmanın gösterdiği yere yayınlanır ve
  geri yüklenen yapılandırma bu yerleşimi gösterir.
- İlk değiştirmeden önce geri yükleme hedefte `.deckent/restore-hold.json` yazar; yalnız sonuncusundan sonra kaldırılır. Bu
  dosya varken servis başlatma ve proje yapılandırmasını yükleyen her komut `BACKUP_RESTORE_HOLD` ile reddedilir.
  `BACKUP_RESTORE_INCOMPLETE` (ya da süreç kaybı) halinde ara dizini (`.deckent/.backup-restore-<uuid>`, özel, yetki anahtarı
  içermez), hasarlı kopyaları ve dış denetim makbuzlarını teşhis için koruyun, sonra aynı geri yüklemeyi `--confirm-target` ile
  yeniden çalıştırın; setteki policy yalnız bu bekletme varken kullanılır. Kaynaklar arası yayın tek atomik işlem değildir.
  Başarılı bir geri yükleme önceki yarım ara dizinleri (proje kökündeki alpha.18 `.backup-restore-<uuid>` dahil) siler;
  kalanları `doctor` listeler.

**Zamanlanmış yedekler.** Etkileşimli yapılandırma seçicisinden `backup.schedule` için off, daily ya da before-upgrade;
`backup.retention` için 3, 7, 14 ya da 30 seçin. Günlük yedek servis açıkken çalışır; before-upgrade bir ledger yükseltmesinden
önce çalışır. `BACKUP_PASSPHRASE` değerini kendi terminalinizde `deckent secret set BACKUP_PASSPHRASE --main` ile (gizli istem)
saklayın; ortam deposunda (hiçbir depo seçilmemişse) değeri servis başlatıcısı sağlamalıdır. Kimlik bilgisi eksikse kabul
edilmiş bir before-upgrade ledger yükseltmesi engellenir. Saklama sınırı yalnız doğrulanmış zamanlanmış setlere uygulanır;
başka adlı operatör dosyaları korunur. Artık doğrulanamayan bir set (ör. parola değişince) bildirilir ve korunur, sonraki
günlük yedeği engellemez; bir yükseltmeden önce ise yükseltmeyi durdurur. Servis kapanışı süren yedeği bekler.

**Denetim.** Yedek denetim makbuzları kimlik bilgisi olmadan principal, kapsam ve policy taşır. Create/verify makbuzları
`audit/backup-operations` altında, restore makbuzları setin yanında `.deckent-backup-audit` altındadır; böylece ledger'ın
değiştirilmesi geri yükleme niyetini silemez. Güvenilir yetki kurulmadan önceki bir hata mühürlenemez ve depolama etkisi
üretmez. Yedekleme ve geri yükleme Linux dosya muhafaza denetimlerine dayanır; başka sistemlerde reddedilir.

## Yöneticiler için iç ayrıntılar

### Kurulum muhafazası

Kurulum, mevcut kullanıcıya ait ve grupça yazılabilir proje ve bootstrap günlük (journal) dizinlerini (örneğin `0775`) kabul
eder; diğer kullanıcılara yazma izni veren dizinleri reddeder. Grup üyeleri dizin girdilerini değiştirebilir; bu, günlük ad
alanının muhafazasını o grupla paylaşır. Günlük dosyaları yine mevcut kullanıcıya ait, tek hard link'li ve özel `0400`/`0600`
izinli olmalıdır. Yeni dizinlerin varsayılanı `0700`'dür. Config yayımı, policy, yapıtlar ve işçi kaynakları daha sıkı, ayrı
kontrollerini korur. Grupça yazılabilir bir proje, ortak yazılabilir bir ürün veri kökünün desteklendiği anlamına gelmez.

### İşçi araç sürümlerinin güncelliği

`deckent doctor --toolchains`, hazırlanmış native profillere sabitlenmiş CLI sürümlerini `@openai/codex` ve
`@anthropic-ai/claude-code` paketlerinin yayımlanmış npm `latest` etiketiyle karşılaştırır (paket başına tek sınırlı okuma,
kimlik bilgisi olmadan). Yalnız bu bayrakla ve `toolchains.currency.mode` değeri `report` iken çalışır; `registryEndpoint` özel
bir registry'ye işaret edebilir, erişilemeyen registry `unknown-offline` bildirir. Cursor'ın belgelenmiş sürüm uç noktası
olmadığından `unsupported` bildirilir. Rapor hiçbir işçiyi güncellemez, yeniden derlemez ya da etkinleştirmez. Aynı rapor MCP
aracı `inspect_toolchain_currency` ve SDK fonksiyonu `inspectToolchainCurrency` ile alınabilir.

`deckent toolchains update [--apply]`, eski sürüm raporunu `toolchains.update.mode` altında (`off | propose | auto`, varsayılan
`auto`) bir sonraki işçi imajı sürümüne çevirir: tipli plan `<data root>/workspaces/toolchains/plans/` altına yazılır.
`--apply` her modda derler; `auto` altında çalışan servis de kendi yenilemesinde uygular. Derleme, paketli derleyiciyi
`workspaces/toolchains/builds/<version>/` altına kopyalar, sınırlı sürede derler ve makbuzundan uygulanmamış (`not-applied`)
bir profil revizyonu önerisi (`proposals/<version>.json`) çıkar. Kurulu config yeniden yazılmaz; öneriyi yeni bir kurulum
profil revizyonu olarak uygulayın. Çalışan iş kendi imajını korur; eski sürümler geri dönüş için kalır.
`toolchains.update.atStartup`, `runtime serve` açılışında güncellik raporunu üretir (yalnız rapor).

### Kodlama işçisi imaj sürümleri

`npm run worker:image -- /abs/path/worker-images/<version>.json`, `assets/worker-image` içindeki üç sağlayıcılı
`deckent/worker` imajını derler. `recipe.json` (şema 2) `imageVersion` (`r<N>-<YYYYMMDD>`) ve `previousVersion` alanlarını
taşır; Dockerfile en yenisi başta bir `# version …` yorum geçmişi tutar, bu geçmiş recipe ile eşleşmelidir ve imaja
`/opt/deckent-worker/Dockerfile` olarak kopyalanır. Her sürüm, OCI etiketleriyle `deckent/worker:<version>` olarak işaretlenen
tek bir değişmez imageId'ye bağlanır; etiketi başka bir imajı gösteren sürüm reddedilir. Güncellemek için geçmişe yeni bir
satır ekleyin, `imageVersion`/`previousVersion` değerlerini artırın, yeniden derleyin ve makbuzun `imageId` değerini yeni bir
execution profil revizyonunda kullanın. Eski imajları, etiketleri ve arşiv makbuzlarını (`worker-images/archive/`) çalışan
Run'lar ve geri dönüş için koruyun; ürün yalnız `imageId` ile bağlanır, imaj çekmez, etiketlemez ya da silmez.

### Native kodlama profilleri

`coding prepare --input <file|-> --json` ve SDK `prepareNativeCodingProfile` bir profil hazırlar; hazırlamak profili
etkinleştirmez ya da yürütme izni vermez. Dış istek `{schemaVersion: 1, template, invocation}` olarak kalır. Yeni `invocation`
verisi `schemaVersion: 2`, `provider`, `cliVersion`, `permissionMode: "unattended"`, `model` ve `prompt` ya da `composition`
alanlarından birini ister. Host CLI sürümünü değil, seçilen imajın ön kontrol makbuzunda ölçülen birebir CLI sürümünü kullanın.

Yapılandırılmış `composition` v1; `task`, `scope` ve `acceptance` metinlerini ister. İsteğe bağlı `core`, `persona` ve
`skills`/`context` dizilerini kabul eder; seçilen her parça `{id, version, text}` taşır. `core` verilmezse paketli, sürümlü
ortak işçi talimatları seçilir. Seçim açıktır: persona/skill kataloğu ya da host dosyası aranmaz. Yinelenen persona/skill
kimlikleri reddedilir. Her metin en çok 16 KiB, serileştirilmiş composition 32 KiB olabilir; en çok 16 skill ve 8 context
parçası. İstemler görev verisi olarak saklanır: hiçbir girdi biçimine kimlik bilgisi koymayın.

Derleyici içeriği, seçilen parça özetlerini ve komut argümanlarını hazırlanmış profile bağlar. İşçi bu bağı doğrular; sonra
çekirdek talimatı Claude'a `--system-prompt` ile, Codex'e özel tmpfs'teki bir talimat dosyasıyla, Cursor'a görevle birlikte
satır içi verir. Docker komut argümanlarında composition istem metinleri yerine yer tutucular bulunur. Sınırlı
`native-prompt-delivery` çıktısı native süreç başlarken özetleri ve seçim üst verisini kaydeder; istem metni ya da kimlik
bilgisi içermez. Bu, süreç girdisinin teslimini kanıtlar, modelin talimata uyduğunu değil; kabul için yine gözlenen görev
sonuçları gerekir. Persona ve skill içeriği yetki vermez.

`discovery` sürümlü veridir: varsayılan `{schemaVersion: 1, mode: "disabled"}`, açık seçenek
`{schemaVersion: 1, mode: "repository"}`'dir ([her modun ne yüklediği](#kodlama-işçisinin-talimatları-ve-keşif)). Bir profil gizli yol
listesini yalnız `invocation.discovery.hiddenPaths` içinde ve yalnız checkout ile gerçekleşen `disabled` modda (Cursor)
değiştirebilir; bunun için henüz CLI yok. Yalnız Claude repository modu, tipli `disableAllHooks: boolean` alanını içeren
`discovery.settings` kabul eder. Bu alan açık `--settings` JSON'una dönüşür; keyfî settings dosyası, yardımcı program, ortam
değişkeni ve kimlik bilgisi reddedilir. Hook'ları kapatmak tek başına depo MCP'sini ya da talimatlarını engellemez.
Discovery-disabled modunda settings reddedilir.

İşçi, kimlik dosyasını yazıp görevi başlatmadan önce boş bir geçici dizinde CLI sürümünü ve gerekli bayrakları kontrol eder.
Uyumsuzluk temizlenmiş bir `preflight` hatasıyla çıkar; API anahtarına ya da başka bir girişe geri düşülmez. İmajın yeniden
incelenmesi güncel denetleyiciyi kullanır ve var olan imaj için de özetlerini kaydeder. Bir CLI'ın yardım çıktısı bir
yeteneğin çalıştığının kanıtı değildir. Eski invocation-v1 hazırlama istekleri anlamları sessizce değiştirilmek yerine
reddedilir. Kalıcı execution profilleri birebir davranışlarını ve yeniden oynatmalarını korur; yükseltme, yeni bir profil
revizyonunun açıkça hazırlanıp kabul edilmesi demektir.

### Yama muhafazası ve entegrasyon

Yama yakalama çalışma alanını taban ağacıyla Git nesne kimliği üzerinden karşılaştırır ve yalnız değişen taban dosyalarını
okur; Git çıktı/süre ya da tarama bütçesi tükenirse `PATCH_LIMIT` ve bir `detail` parametresiyle (`git-output`,
`git-timeout`, `time`, `bytes`, `entries`, `depth`, `path`) kapanır. `execution.git.outputBytes` varsayılanı 4 MiB'dir.

Saklanan bir çalışma alanı yaması için `deckent task integration-check`, kayıtlı tabanı HEAD ve etkilenen index/çalışma ağacı
dosyalarıyla karşılaştırır. `task patch-preview` ile aynı kimlik bayraklarını kullanın. `task integration-prepare` ayrıca
`--command-id <id>` ve kontrolün `--proposal <code>` değerini alır ve `prepare-integration` policy iznini ister. İki komut da
`--json` destekler ve runtime servisi olmadan yerel depolamayı kullanır.

Hazırlama, yapılandırılmış workspaces kaynağının `integrations` dizininde ayrı bir Git adayı oluşturur. Aday kayıtlı taban ve
yamayı içerir; kaynak dosyaları, HEAD ve index değişmez. Hazırlanmış aday görev kabulü ya da teslim değildir. Tamamlanmış bir
komutu yinelemek adayını doğrular; kesilmiş bir komut `PATCH_INTEGRATION_PENDING` bildirir ve dosyalarını otomatik onarım ya da
devralma olmadan korur. Eski bir ledger, hazırlamadan önce açıkça yükseltilmelidir (kurulum/depolama yükseltmesi); salt okunur
kontrol ve olağan hazırlama onu asla sessizce yükseltmez.

`task integration-inspect` aynı kimlik bayraklarını ve `--command-id <id>` alır, yalnız `read-output` iznini ister. Mevcut
ledger ve değişmez manifest'ten `absent`, `pending` ya da `manifest-recorded` bildirir. Execution yapılandırması olmadan
çalışır; depolamayı yükseltmez, adayları onarmaz ve güncel dosyalarını yeniden kontrol etmez.

### Dağıtım uzantı girişi

Açık uzantı girişi, bir CLI dağıtımının etki adaptörleri, gizli depo adaptörleri ve sır yardımcıları, onay güvencesi
üreticileri, MCP yetki grupları ve sağlayıcı ücretsiz çağrı sertifikaları kaydetmesini sağlar. alpha.20'den beri aynı dağıtım
kayıtlarıyla servisi ve MCP girişini de başlatabilir; otomatik servis başlatma ve yeniden başlatma dağıtımın girişini yeniden
çalıştırır (elle çalıştırılan `npm run smoke:dist` ile sınanır, CI'da değil). Core'un yalın çalıştırılabilir dosyaları bu
modülleri kendiliğinden keşfetmez.
