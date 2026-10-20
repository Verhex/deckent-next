# CLI komut incelemesi (2026-10-19)

PLAN.md Sıradaki 14 **CLI-INSAN** maddesinin komut başına ayrıntısı; CLI-INSAN beta kapısı 8'dir (owner 2026-10-19). Her bölüm kurulu sürümde gerçek çağrıyla ölçülür, kaynak katalog tek başına kanıt sayılmaz.
Yöntem: (1) kurulu sürümde ne yaptığı, (2) ne işe yaradığı, (3) argümansız ne yapmalı, (4) etkileşimli hâli. Ölçüm ortamı: `deckent v1.0.0-alpha.46`, commit `a4d2d444`, WSL, Node v26.10.0.

## Ana oturuma devir: alpha.48 (owner 2026-10-19)

Owner bu incelemenin tamamını alpha.48 paketi olarak ana oturuma iletir; CLI-INSAN beta kapısı 8'dir. `operation` ve `terminal` bölümleri owner'ın genel onayıyla yazıldı, tek tek sunulmadı. Uygulama sırası ana oturumun planıdır; aşağıdaki gruplama öneridir.

**Öncelikli (owner işaretli):**
1. `task integration-queue-list` insan modunda ham JSON; `parked` teslim fark edilmez (beta kapısı 4 yolunda).
2. `backup verify` var olmayan sette "parola yanlış ya da set değiştirilmiş" (`BACKUP_PASSPHRASE_INVALID`); hata türleri ayrışır.

**Ortak işler (her komutta bir kez):**
- **Dil:** komutlar dili config `language`'dan çözer; bugün `report.ts:16` ve benzeri 12 dosya yalnız `--lang`/ortam okur, hata başlığı TR gövde İngilizce kalır.
- **Boş komut yok:** her komut argümansız ya güvenli varsayılan okuma eylemini yapar ya alt komut listesi + eksik argüman adını verir (çıkış 2 korunur). Ölçüm: 27 komuttan 20'si argümansız yalnız `CLI_USAGE`.
- **Ana yardım:** 100–150 satır, Komutlar/Seçenekler ayrı, alt komut + argüman imzası, yüzeyler anlatılır, `--help --all` kalkar; `cli-grouped-help.test.ts` (`<= 30`) ve katalog notu değişir.
- **Scope:** varsayılan yalnız okumada ve çıktıda yazılır; değişiklikte TTY seçici + onay, AI yolunda `--scope` zorunlu (bugün `pool.ts:44` sessiz varsayılan); scope listesi.
- **Kimlik:** `run list` + kısa kimlik (git gibi); `report`, `run inspect`, `task`, `approval` aynı seçiciyi kullanır; iç kimlikler (`--command-id`, `--expected-revision`, attempt/generation/layout) insan yolunda sistemce.
- **Ham JSON yok:** `approval` (`approvals.ts:28`), kuyruk, `mcp list/get`, `secret list`, `secret store --list`, `policy vocabulary`, `paths`, `toolchains update`, `terminal chat-plan`, `config get` (insan özeti) okunur çıktıya döner; JSON yalnız `--json`.
- **İnsan biçimi:** bayt → MB/GB, ms → sn/dk, epoch → yerel saat, kayan nokta gürültüsü yok, hash/UUID `--verbose`; listeler bekleyen önce, sonra yeniden eskiye.
- **Yardım = davranış:** katalogda olmayan alt komutlar kaydedilir (`pool quota-release`, `policy mcp`); test eşitliği korur.
- **Hata doğruluğu:** yanlış alanlı hatalar (`INVENTORY_QUERY_INVALID` → approval/operation girdisi, `CLI_INVOCATION_INPUT_INVALID` → "Model çağrısı" karar girdisinde, `IDENTITY_PROFILE_INVALID` → profil seçilmemiş) doğru nedeni ve eksik alanı adıyla söyler; JSON girdili komutlarda yardımda örnek + `--schema`.
- **Kabul kanıtı:** kabul satırı kanıt türünü söyler (ör. `process-exit@1` → "kabul: çıkış kodu · içerik bağımsız doğrulanmadı"); Kanun 1.
- **TTY akışları:** onay kartı (bir kez / bu oturum / her zaman / hayır; sert tabanda "her zaman" yok), değerler yalnız seçimle (owner 10-08; MCP komut/URL istisnası önizleme + onayla), değişiklik öncesi önizleme kartı, terminaldeki slash pencereleriyle tek uygulama.

**Açık sorular (uygulamada kaynakta çözülür):** `inventory` 8 / `workers` 64 kayıt farkı; `coding template --preview` "toolchain yok" ama canlıda profil kullanılıyor; `paths` ve `doctor` farklı soket yolu; `workers`'taki 21 `stale` kaydın gerçek durumu; terminal "bağlam ?" nedeni.

**Ölçülmeyenler:** yazan/etki üreten alt komutlar (her bölümde adıyla), terminal slash komutları, TTY `/doctor` ve `/config` pencereleri, Windows/macOS, gerçek `backup verify` (parola owner'da), canlı `do` isteği (owner atladı).

**Diğer yüzeylere girdi:** profil seçimi `init` adımıdır (`init` yan oturumu analizi); `monitor` revizyonunu owner betada ayrıca verir.

## doctor

**Ölçüm:** argümansız çalışır (çıkış 0, ~1,1 s); TR çıktı, `--lang en`, `--json` (23 alan) ve `--toolchains` (npm registry'ye çıkar, salt okunur) çalışır. Terminalde `/doctor` slash kaydı var; TTY'de doğrulanmadı.

**Ne yapar:** iş başlatmadan kurulum sağlığı: platform, CPU/bellek ve önerilen worker, principal, audit bütünlüğü, runtime başlatılabilirliği, secret deposu, kurulum dizini izinleri, worker imajı, kurulum bağı, politika yönetimi, havuz hazırlığı, sandbox öz-testi; `--toolchains` ile claude/codex/cursor güncelliği.

**Bulgular:**
1. TR çıktıda ham İngilizce değerler: `Durum: ready`, `(ready)`, `stale`/`fresh`/`not-admitted`, `mod report`.
2. İç ayrıntı sızıyor: soket yolu `/tmp/dk-1000-…/s`, `core.secret-store.encrypted-file@1`, `[terminal.shell.realm prefer-sandbox]`, anlamsız `(-)` (`Worker imajı: güncel (-)`, `Havuz hazırlığı: hazır (-)`); imaj "güncel" ama JSON'da `imageVersion: null`.
3. Uyarılar ayrışmıyor: `.deckent` 0755 uyarısı ve `claude: stale` diğer satırlarla aynı görünür.
4. Uyarının sonraki adımı eksik: `claude: stale` yanında `deckent toolchains update` yok (chmod önerisi var).
5. Node sürümü (`v26.10.0`, taban `24.22.0`) yalnız JSON'da.
6. Tekrar: "Politika yönetimi: 1 kullanılabilir admin. Politika yönetimi kullanılabilir."
7. Yardım `--toolchains`'in ne yaptığını ve ağa çıktığını söylemez.

**Kabul edilen hâl (owner 2026-10-19):**
- Gruplar: Kurulum / Güvenlik / Çalışma / Araçlar; her satırda renkten bağımsız metin işareti (`tamam` / `uyarı` / `hata`); en üstte özet ("Durum: hazır · 2 uyarı").
- Her uyarı tek sonraki adımı tam komutla söyler; iç ayrıntılar varsayılan çıktıda gizli, `--verbose`/`--json` ile görünür; Node sürümü varsayılan çıktıda.
- **Etkileşimli doctor (beta kapsamı):** TTY'de düzeltilebilir maddeler (ör. `chmod 700 .deckent`, araç güncelleme) ok tuşlu kartla önerilir, onayla uygulanır, sonuç yeniden ölçülür (Claude Code `/doctor` gibi). Pipe/`--json`'da soru yok, sözleşme aynı. Düzeltme mevcut policy/onay yolundan geçer; sert taban maddeleri önerilmez.

## config

**Ölçüm:** argümansız `deckent config` pipe'ta da PTY'de de (120×40) seçim penceresi açmaz, 2061–2100 satırlık tablo basar; başta 64 karakterlik belge özeti, anahtarlar 31 sütunda bölünür (`artifacts.patchPreview.maxEntri`/`es`), Brain prompt metni dar sütuna dökülür. `config get` 2198 satır JSON; `config get language` → `tr` (çıkış 0); bilinmeyen anahtar TR hata (`CONFIG_KEY_UNKNOWN`, çıkış 2). `config explain language` çalışır ama İngilizce ve iç yol gösterir (`Binding: bound: src/surfaces/core/cli`); argümansız `explain` İngilizce `CLI_USAGE`. `config validate` İngilizce ("Configuration is valid."). `set`/`unset` yazdığı için çalıştırılmadı; değer elle JSON (`set <anahtar> <json>`). Terminal `/config` slash kaydı var; TTY'de doğrulanmadı.

**Bulgular:**
1. Owner 10-08 kuralı (config değeri yalnız seçimle, elle değer yok) insan CLI yolunda karşılanmıyor; AI için tipli JSON doğru kalır.
2. Anahtar keşfi yok: 2000 satırlık döküm dışında liste/arama yok.
3. `explain`/`validate` İngilizce; argümansız `explain` genel hata; yardım hizası bozuk (`validate` satırı kaymış).
4. Varsayılan çıktı gürültülü: birkaç geçersiz kılma yüzlerce varsayılanın içinde kaybolur; özet hash ve iç yol insana anlam taşımaz.

**Kabul edilen hâl (owner 2026-10-19):**
- TTY'de argümansız `deckent config` = terminal `/config` ile aynı seçim penceresi (tek uygulama): gruplar ve yazarak arama → anahtar → izin verilen değerler ok tuşuyla → önce/sonra onay kartı → yazım ve gerekiyorsa yeniden başlatma uyarısı.
- Pipe'ta argümansız: yalnız geçersiz kılınan değerler + grup sayısı + "tamamı: `deckent config get --json`"; tam döküm varsayılan değil.
- `explain` ve `validate` TR; argümansız `explain` anahtar listesi (TTY'de seçici); iç yol yalnız `--verbose`.
- Tablo terminal genişliğini kullanır; uzun değer kısaltılır, sonuna "tam değer: `config explain <anahtar>`".
- `config set`: AI yolu `<json>` aynı; TTY'de değer verilmezse izin verilen değerler seçicisi.
- Serbest değerler: sayılar şema sınırları içinde hazır seçenekler + şema denetimli "özel değer"; yollar yalnız var olan ve izin verilen dizinlerden seçilir.

## do (owner atladı, karar yok)

**Ölçüm:** argümansız genel `CLI_USAGE`; değersiz `--scope` hatasında başlık TR, gövde İngilizce (argümanlar config dili okunmadan ayrıştırılıyor; diğer komutlarda aynı kök olası, doğrulanmadı). Gerçek istek gönderilmedi (canlıda Brain çağrısı + öneri kaydı). Kaynaktan: `--scope` yoksa `terminal.scopeId`; öneri sonrası metinler terminal dilinde ("N ile reddedin", "/do", "/tasks"), CLI karşılığı (`deckent approval decide`) söylenmiyor; gelen kutusundaki "CLI `do` onaydan sonra devam etmiyor" ile örtüşür.

## monitor (owner: beta revizyonu ayrıca verilecek)

**Ölçüm:** argümansız çalışır (çıkış 0), TR: "Deckent izleyici · gözlem 2026-10-19 01:26:47+03 · yalnız gözlem". Ayrıntılı inceleme yapılmadı; owner revizyonu betada ayrıca verilecek.

## workers

**Ölçüm (`live`):** argümansız ve `--scope`'suz `list` genel `CLI_USAGE` (çıkış 2). `workers list --scope live` çalışır (çıkış 0): 285 satır, 64 kayıt, çalışan worker yok (41 `released`, 21 `stale` (en yenisi ~12 sa), 2 `unavailable`). `watch` aynı tam listeyi akıtır. `--json` çalışır. `--lang` yoksa çıktı İngilizce, `--lang tr` ile büyük ölçüde TR (config dili okunmuyor). `--scope pilot` kabul edilir (eski `deckent-dev` kaynağı `unavailable`); kayıtsız scope İngilizce `SCOPE_UNKNOWN` (çıkış 1), geçerli scope'ları listelemez.

**Bulgular:**
1. Varsayılan görünüm geçmişi döker; "şu an ne çalışıyor" 285 satırda kaybolur, özet ve filtre yok.
2. TR çıktıda bile ham değer: 64 hex run kimliği, bayt RAM, ms yaş, `0.49022299999999996 s`, UTC ISO saat, `missing 134`, `heartbeat`, `unknown`, `$-`.
3. 21 `stale` kaydın gerçek durumu (ölü mü, temizlik mi bekliyor) söylenmez; `doctor` havuzu hazır gösterir. Doğrulanmadı.
4. Bilinmeyen scope hatası geçerli scope'ları söylemez.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent workers` = varsayılan scope'ta `list` (okuma); ilk satır özet: "scope: live · 0 çalışan · 64 geçmiş".
- Varsayılan liste yalnız etkin worker'lar; geçmiş `--all`/`--since` ile.
- Worker başına tek satır: görev adı · durum (çalışıyor/bitti/kayıp) · model · süre · CPU ve MB/GB RAM · "12 sa önce"; kısa kimlik, tam ayrıntı `--verbose` veya seçimle.
- TTY'de `watch` sınırlı canlı pencere; satır seçimi ayrıntı, Esc çıkış. `--json` aynı. `stale`/`unavailable` kayıt için yapılacak iş (temizleme/kayıp ilanı) açıkça yazılır.
- `workers` AI ve ayrıntılı kaynak görünümü olarak kalır; insanın ana izleme yeri `monitor`; `workers` yardımı "izlemek için `deckent monitor`" diye yönlendirir.

## report

**Ölçüm (`live`, run `5ff7e6cb…`):** `--run` yoksa genel `CLI_USAGE` (çıkış 2). Gerçek run ile çalışır (çıkış 0): görev kabul sayıları, CPU, API maliyeti "bilinmiyor USD", görev başına profil/model/effort/tepe bellek/süre; abonelik/yerel model çağrısı, insan müdahalesi, yeniden iş, geri alma "bilinmiyor"; "Kıyas için kanıt yetersiz (0 eş)". `--lang` yoksa İngilizce; kök `src/surfaces/core/cli/internal/report.ts:16` dili yalnız `--lang` ve ortamdan çözer, config `language` okunmaz; aynı kalıp 12 dosyada (hepsi tek tek doğrulanmadı). Olmayan run İngilizce `RUN_NOT_FOUND` (çıkış 1).

**Bulgular:**
1. Run kimliğini bulmanın insan yolu yok: CLI'da `run list` yok, kimlik 64 hex; tek dolaylı yol İngilizce ve ham `deckent inventory`.
2. Ölçülen run'da 10 alanın 7'si "bilinmiyor"; hangi alanın neden boş olduğu söylenmez.
3. Ham değerler: `0.49022299999999996 s`, `583852032 bayt`, `20900 ms`, uzun profil hash'i, tam attempt UUID'si; "kabul kabul edildi" tekrarı.
4. Yardım raporun neyi ölçtüğünü ve alanların anlamını anlatmaz.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent report`: varsayılan scope'ta son run'lar (okuma); TTY'de ok tuşlu seçim → rapor; pipe'ta son N run tek satır özet + "ayrıntı: `deckent report --run <kısa kimlik>`".
- Kısa kimlik kabul edilir (git gibi); belirsizse adaylar listelenir.
- Rapor iki bölüm: **Bilinen** (sonuç, süre, CPU/RAM, model) ve **Ölçülemeyen** (her alanın nedeni, ör. "abonelik çağrısında ücret ölçülemez").
- İnsan biçimi: 0,49 sn, 557 MB, 20,9 sn; hash'ler `--verbose` ile.
- Run bulma yolu ayrı `deckent run list`; `report`, `run inspect` ve `task` aynı seçiciyi kullanır; terminal `/runs`'ın CLI karşılığı.

## run

**Ölçüm:** argümansız İngilizce `CLI_USAGE` (çıkış 2). `run inspect --scope live --id <64 hex>` çalışır (çıkış 0, 83 satır, İngilizce); kısa kimlik (`5ff7e6cb`) `RUN_NOT_FOUND`. `create`, `propose`, `reserve`, `cancel`, `close`, `hold`, `resume` yazdığı için çalıştırılmadı; hepsi `--command-id` + `--expected-revision` ister, `create` graph JSON, `propose` öneri JSON bekler.

**Bulgular (`run inspect`):**
1. "Evaluation: accepted" değerlendiricisi `process-exit@1`: kabul işlem çıkış koduna dayanır; içerik doğruluğu worker beyanıdır (`CLAIM …`). Kanun 1 gereği ekran kanıt türünü söylemez.
2. Çelişki ve tekrar: "Acceptance: class unknown · policy unknown · profile unknown · accepted · criteria unknown" sonrasında profil ve kriter adı verilir; run kimliği 4 kez; `report` çıktısı başa kopyalı.
3. Gizli bilgi kapısı istisna listesi 64 yol satır satır basılır (`.npmrc` `acknowledgedDenyPaths` ile açılmış); denetimli istisna kanıtı ama varsayılan görünümde gürültü.
4. Ham değerler: hash, UUID, `sequence 2454`, "revision 3 (not live status)".

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent run` alt komut listesi; `run list` son run'lar; kısa kimlik her alt komutta.
- `run inspect` varsayılan sırası: istek → sonuç → görevler → kabul kanıtının türü → teslim; iç kayıt, gizli bilgi istisnaları ve hash'ler `--verbose`; istisnalar tek satır özet ("64 yol istisnayla geçti, 1'i red listesinden: `.npmrc`"); TR; TTY'de id yoksa seçici.
- `cancel`/`hold`/`resume`/`close`: TTY'de run seçici, revizyon otomatik okunur, scope ve hedef onay kartında; AI yolunda `--scope`, `--command-id`, `--expected-revision` zorunlu.
- `create`/`propose`/`reserve` AI ve otomasyon JSON yolu; yardım insanı `deckent do`'ya yönlendirir.
- Kabul satırı kanıt türünü söyler (`run inspect`, `report`, `/runs`): ör. "kabul: çıkış kodu · içerik bağımsız doğrulanmadı".

## task

**Ölçüm (run `5ff7e6cb…`, görev `create-do-test-file`):** argümansız İngilizce `CLI_USAGE` (çıkış 2). `task inspect` çalışır (54 satır, İngilizce; çoğu 64 yollu gizli bilgi istisna listesi; aynı "Acceptance: … unknown · accepted" çelişkisi). `task transcript` çalışır, en okunur çıktı (zaman çizelgesi, token/önbellek %78, araç sayıları, "abonelik kullanımı ücret değildir"), İngilizce. `task patch-preview --stat` çalışır ("1 files, +1 -0", önizleme ≠ kabul), İngilizce. `task integration-queue-list --scope live` insan modunda **ham tek satır JSON** basar (başında TR "Kuyruk sonucu:"; `labelKey: queue.git.target` gibi anahtarlar çözülmemiş). `execute`, `evaluate`, `accept`, `reject`, `patch-prepare`, `integration-*`, `queue-enqueue/confirm/rollback` yazdığı için, `integration-inspect` `--command-id` gerektirdiği için çalıştırılmadı.

**Bulgular:**
1. **Öncelikli (owner 2026-10-19):** teslim kuyruğu listesi okunamaz; sonuçlar (`adopted`, `stale-refused`, `verification-failed`, `parked`) ve `nextAction` JSON içinde; `parked` bir teslim fark edilemez. Beta kapısı 4 (init → /do → teslim) yolunda.
2. 19 alt komut tek listede; teslim zinciri (`patch-prepare` → `integration-check` → `integration-prepare` → `integration-deliver` → `integration-adopt` → `integration-rollback`) + 5 kuyruk komutu, her adım attempt/generation/layout-revision/command-id ister; insan hangi adımda olduğunu bilemez.
3. Ortak: kısa kimlik yok, dil config'den okunmaz, istisna listesi gürültüsü, kabul satırı çelişkisi.

**Kabul edilen hâl (owner 2026-10-19):**
- TTY'de argümansız `deckent task`: run → görev seçimi → görevin o anki durumuna göre yalnız geçerli eylemler menüsü (ör. kabul edilmişte İncele / Transkript / Fark / Teslim et); teslim zinciri onay kartlarıyla adım adım; attempt, revizyon, command-id sistemce; terminal `/runs` ve `/deliver` ile aynı akış.
- Pipe'ta alt komutlar gruplu: İncele · Yürüt ve değerlendir · Teslim · Kuyruk; AI uzun adları ve argümanları aynı.
- `integration-queue-list` tablo: görev · hedef dal · durum (benimsendi / doğrulama başarısız / bekliyor / eski temel) · sonraki adım; bekleyen en üstte; ham JSON yalnız `--json`.
- `transcript` ve `patch-preview` biçimi korunur, TR olur. `inspect` `run inspect` kurallarını izler.

## pool

**Ölçüm:** argümansız genel hata (çıkış 2). `pool status` `--scope`'suz çalışır (varsayılan `live`, çıkış 0), 3 satır İngilizce: "Pool live: open (revision 0, by - at -, reason: -)", "Reserved or running: 0; in flight incl. evaluating: 0; drained: false", "capacity 4/4; last change -, by -, at -". `hold`, `resume`, `set-capacity`, `quota-release` yazdığı için çalıştırılmadı; kaynak okundu.

**Bulgular:**
1. Değişiklik komutları bugün sessizce `live`'a gider: `src/surfaces/core/cli/internal/pool.ts:44` `--scope` yoksa `terminal.scopeId` kullanır; `hold`, `resume`, `set-capacity`, `quota-release` dahil. Yeni scope kuralıyla çelişir.
2. Gizli alt komut: `quota-release` kodda çalışır (`pool.ts:33`) ve kullanım metninde yazar, ama katalogda yok: "Komutlar" listesinde görünmez, `deckent pool quota-release --help` hata verir.
3. Çıktı anlaşılmaz: "capacity 4/4" neyin kapasitesi söylenmez, `doctor`'un "önerilen worker: 15" ile ilişkisi açıklanmaz; `by - at - reason: -` boş alanları, "drained: false".
4. Yardım dağınık: yetki ve `quota-release` ayrıntısı alt komut listesinden önce.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent pool` = varsayılan scope'ta `status` (okuma).
- `status` insan diliyle ve TR: "Havuz live · açık", "Şu an: 0 çalışan, 0 değerlendirmede", "Kapasite: aynı anda en çok 4 iş (makine önerisi 15 — deckent doctor)"; boş alanlar gösterilmez.
- `hold`/`resume`/`set-capacity`/`quota-release` yeni scope kuralına uyar: TTY'de scope seçici + "ne, hangi havuz, neden" sorusu, `set-capacity` değeri hazır seçeneklerden; **AI yolunda `--scope` zorunlu** (bugünkü varsayılan davranış değişir, owner kabul etti).
- `quota-release` kataloğa kaydedilir.

## decide

**Ölçüm:** argümansız genel hata (çıkış 2). Beş alt komut (`prepare`, `ask`, `record`, `outcome`, `inspect`) yalnız `--input <dosya|->` JSON alır; yardım JSON biçimini ve örnek göstermez (biçim yalnız `src/engine/core/decision/internal/contract.ts`'te). Kararları listeleyen yol olmadığından gerçek `inspect` yapılamadı; bu kurulumda karar kaydı olup olmadığı doğrulanmadı. `{}` girdisinde yanlış alanlı hata: "**Model çağrısı** JSON verisi veya komut şeması geçersiz" (`CLI_INVOCATION_INPUT_INVALID`), eksik alanı söylemez. Dogfood Jev kullanımı host `jev-review.mjs` üzerinden; `deckent decide` kullanılmıyor olabilir (doğrulanmadı).

**Kabul edilen hâl (owner 2026-10-19):**
- **Beta:** argümansız `deckent decide` varsayılan scope'ta son kararlar (okuma); TTY'de seçilen karar için seçenekler, tavsiye, seçim ve sonuç tek pencerede; yardımda her alt komut için JSON alanları + küçük örnek; `deckent decide <eylem> --schema` JSON şemasını basar; hata doğru alanı ve eksik alanı adıyla söyler.
- **Beta sonrası:** TTY'de etkileşimli "sor" formu (soru ve seçenekler formla, Jev tavsiyesi kartta, ok tuşuyla seçim ve kayıt).

## models

**Ölçüm:** argümansız `deckent models` çalışır (18 satır, İngilizce): "Declared model catalog connect-a386e463…", bağlı sağlayıcı beyanları (Anthropic API, DeepSeek, yerel vLLM Qwen, OpenAI, OpenRouter), "kullanılabilirlik gözlemlenmez". `models catalog list --scope live` ayrı ikinci liste (39 satır, İngilizce): worker kataloğu, 6 kanal; bu scope'ta yalnız claude ve codex abonelik kanalları etkin; yerel vLLM bu listede yok. Argümansız `binding`, `activation`, `spending`, `catalog`, `catalog list` genel hata (çıkış 2). `binding`/`activation`/`activate`/`deactivate` sağlayıcı ve model sürümü + `--binding-digest <sha256>`; `invoke`/`spending` vb. JSON; `connect` tam API kimliği ister. Yazanlar çalıştırılmadı.

**Bulgular:**
1. İki "katalog" (beyan ve worker kataloğu) farkı anlatılmaz; ikisi aynı modelleri göstermez; "bu scope'ta hangi modelle iş yapabilirim" doğrudan cevaplanmaz.
2. Emekliliği geçmiş modeller yanlış etiketli: `claude-haiku-4-5-20251001` "lifecycle active (retire 2026-10-15)", `gpt-5.5` "deprecated (retire 2026-10-14)" (bugün 2026-10-19; ikisi de bu scope'ta etkin değil). Katalog verisi güncelliği beta sonrası gözlem işidir (owner 10-17); burada konu gösterim.
3. Ham değerler: `@1`, `protocols openai-chat-completions@v1[tool-calls@1:supported]`, `CLI ≥ —`, `aliases (refused) —`, `retire —`, bağlantı hash'i.
4. İnsan model etkinleştiremez (SHA-256 bağ özeti, revizyon, sürüm gerekir).

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent models`: "Scope live'da kullanılabilir modeller" tek tablo, kanala göre gruplu: model · kanal (abonelik claude/codex · API anthropic/openai/…) · durum (etkin / etkin değil / emekli) · effort; beyan listesi `--declared`, ham ayrıntı `--verbose`; TR.
- Emekliliği geçmiş model "emekli (tarih)"; etkin modelde emekliliğe **15 gün** kala uyarı, `doctor`'da da görünür. Eşik config'de, varsayılan 15 (Kanun 6).
- TTY'de `activate`/`deactivate`/`connect`: sağlayıcı → katalogdan model (tam API kimliği, takma ad yok; owner 10-08) → bağ özeti ve revizyon sistemce → scope'lu onay kartı; AI yolu aynı.
- Argümansız `models spending` varsayılan scope bütçe/harcama özeti (okuma); JSON AI yolu kalır.
- Yardım iki listeyi bir cümleyle ayırır: "beyan: bağlı sağlayıcılar · katalog: worker'ların kullanabileceği modeller".

## approval

**Ölçüm:** argümansız genel hata (çıkış 2). Dört alt komut (`list`, `inspect`, `decide`, `renew`) yalnız `--input` JSON; yardım biçimi göstermez. `{"schemaVersion":1,"scopeId":"live"}` → İngilizce "Invalid inventory query. Check scope, cursor and page size." (`INVENTORY_QUERY_INVALID`, çıkış 2): yanlış alan adı, eksik `afterId`/`limit` söylenmez. Doğru girdiyle (`afterId: null, limit: 3`) çalışır (çıkış 0) ama insan modunda girintili ham JSON basar; kök `src/surfaces/core/cli/internal/approvals.ts:28` her sonucu `JSON.stringify` ile basar (dört alt komut). Sıra en eskiden (ilk kayıt 2026-09-30, karara bağlanmış); bekleyenler öne gelmez, durum filtresi yok; zaman epoch ms, digest/policy hash/UUID. `decide` yazdığı için çalıştırılmadı (kaynak: `commandId`, `expectedRevision`, `decision` allow/deny, zorunlu `reason`).

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent approval`: varsayılan scope'ta bekleyenler en üstte (okuma); satır: ne istendi (araç + komut özeti) · kim · bitiş ("8 dk kaldı").
- TTY: bekleyen seçilir → terminal onay kartının aynısı (bir kez / bu oturum / her zaman / hayır; sert taban maddesinde "her zaman" yok) → gerekçe isteğe bağlı (boşsa "Terminalde onaylandı") → revizyon ve command-id sistemce.
- Pipe: okunur tablo, yerel saat; ham JSON yalnız `--json`.
- AI yolu: JSON `--input` aynı; yardımda alanlar + örnek, `--schema`; hata eksik alanı adıyla söyler.
- Gerekçe: insan için isteğe bağlı; AI kararlarında ve "her zaman" kurallarında zorunlu.

## policy

**Ölçüm:** argümansız genel hata (çıkış 2). `policy status` TR çalışır (1 admin, elle kurulmuş politika, revizyon hash'i, etiketsiz `DESKTOP-7NLBLGA/1000`, "Politika yönetimi kullanılabilir." tekrarı, "Dış kimlik… doğrulanmadı"). `policy grants` `--mine`'sız genel hata; `--mine` ile TR "Bu kapsamda kayıtlı kalıcı onayınız yok." `policy delegations --scope live` TR: AI'a devredilebilen 6 adım hepsi kapalı, ifade "Yönetilen izin yok / etkin durum: Seçimin bütününe izin yok". `policy mcp list` TR: iki scope'u (`pilot`, `live`) gösteren tek komut; tüm MCP gruplarında "Grup izni yok / Etkin yetki yok". `policy vocabulary` insan modunda 180 satır ham JSON. `policy upgrade --template current --preview` TR, ham "(not-first-run)". `delegate`, `undelegate`, `revoke`, `upgrade --apply`, `mcp grant/revoke` yazdığı için çalıştırılmadı (`revoke`'ta `--yes` var).

**Bulgular:**
1. Gizli alt komut: `policy mcp list|grant|revoke` çalışır, kullanımda yazar, "Komutlar" listesinde yok.
2. `grants` için `--mine` zorunlu; argümansız hata.
3. `vocabulary` insan modunda ham JSON.
4. İfade ve ham değer: "Seçimin bütününe izin yok", "Operatör dışı beklemeden sürdür", revizyon hash'leri, etiketsiz principal, `not-first-run`.
5. Bilgi (karar değil): `live`'da hiçbir MCP grup izni yok, MCP üzerinden AI bu scope'ta iş yapamaz; kısıtlı varsayılan olduğu düşünülüyor, doğrulanmadı.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent policy`: varsayılan scope politika özeti (okuma): admin, politika türü, kalıcı izinlerim, AI'a devredilen adımlar, MCP grup izinleri özeti.
- Argümansız `grants` kendi izinlerim; admin için `--all`.
- `vocabulary` okunur tablo (kaynak · eylemler); JSON yalnız `--json`.
- TTY'de `delegations` ve `mcp` açık/kapalı seçim listesi → önizleme kartı → onayla uygulama; AI yolu aynı.
- "kapalı / açık" düz ifade; hash'ler `--verbose`; principal etiketli ("Admin: …").
- `policy mcp` kataloğa kaydedilir.

## backup

**Ölçüm:** argümansız ve `--set`'siz İngilizce genel hata. Parola gizli istem veya stdin, argüman olamaz; parola owner'da olduğu için gerçek `verify` yapılmadı; `create`/`restore` yazdığı için çalıştırılmadı. `config get backup`: `schedule: before-upgrade`, `retention: 7`. Var olan setler yalnız dosya sisteminde bulundu: `.deckent/live-data/state/backups/recovery/` altında 2026-10-09–10-15 arası en az 5 set.

**Bulgular:**
1. **Öncelikli (owner 2026-10-19):** `backup verify --scope live --set /nonexistent` (yol yok) → "Parola yanlış ya da kurtarma seti değiştirilmiş: set açılamıyor… set özgün değildir, başka bir set kullanın." (`BACKUP_PASSPHRASE_INVALID`, çıkış 78). Kurtarma anında yanlış teşhis.
2. Set listeleme yolu yok: konum, tarih, doğrulanma durumu gösterilmez.
3. Yardım varsayılan konumu, `before-upgrade` zamanlamasını, 7 set saklamayı söylemez; `restore` önkoşulları tek satırda.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent backup` set listesi (okuma): tarih · boyut · tür (otomatik yükseltme öncesi / elle) · son doğrulama · yol; üstte zamanlama ve saklama.
- TTY'de `verify`/`restore`: listeden set → gizli parola istemi → `restore` için hedef, servis durumu (çalışıyorsa önce durdurma önerisi) ve eski dosyaların taşınacağı yer onay kartında.
- Hata ayrımı: set yok / set okunamıyor / parola yanlış / set değiştirilmiş; her biri kendi sonraki adımıyla.
- `--set` yoksa TTY'de seçici, pipe'ta set listesiyle hata.

## identity

**Ölçüm:** argümansız genel hata. `identity profiles` çalışır (İngilizce başlık): Custom, Enterprise, Solo, Team; her satırda 64 hex digest, başta registry hash'i; profil farkı anlatılmaz. `identity choices --scope live` çalışır ama etiketsiz (`core:team@1: profile-reader, profile-contributor`, `os-34182d…: alperen@DESKTOP-7NLBLGA`, `live`). `identity preview --scope live` İngilizce "Invalid identity profile or package." (`IDENTITY_PROFILE_INVALID`, çıkış 2); gerçek neden config `identity.profile.id` boş, yani profil seçilmemiş. `config get backup` grup olarak çalışırken `config get identity` "bilinmeyen anahtar". `distribute --apply` yazdığı için çalıştırılmadı.

**Bulgular:**
1. Kurulumda kimlik profili seçili değil; `doctor` ve `identity` söylemez, `preview` "profil geçersiz" diye yanlış teşhis verir (owner 10-05 solo/team/enterprise/custom kararı bu kurulumda uygulanmamış görünüyor).
2. `choices` etiketsiz, okunamaz.
3. `profiles` farkı anlatmaz, yalnız hash.
4. Yardım iki kullanım bloğu ve düz metin alan listesi.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent identity` durum özeti (okuma): profil (seçilmemişse seçme yolu), kişiler, roller.
- `profiles` her profil için tek satır açıklama (Solo: tek kişi, tüm yetki · Team: küçük ekip, okur/katkıcı · …); digest'ler `--verbose`.
- `choices` etiketli tablo: Profil · Roller / Kişiler / Scope'lar.
- TTY: profil seçimi → kişi/rol atamaları listeden → önizleme kartı → onayla `distribute --apply`; bugünkü numaralı seçim yerine ok tuşlu seçim; AI yolu aynı.
- Profil seçilmemişse hata bunu söyler ve yolu verir; `doctor` "kimlik profili seçilmemiş" uyarısı gösterir. `config get identity` grup olarak çalışır.
- Profil seçimi `init` adımıdır (init sorar) ve `doctor` uyarır; **`init` yan oturumu analizine girdi.**

## mcp

**Ölçüm:** argümansız genel hata. `mcp list` çalışır ama insan modunda 87 satır ham JSON (iki sunucu: `filesystem` local, **onay bekliyor**, stdio `npx @modelcontextprotocol/server-filesystem`; `context7` user, güvenilir, stdio `context7-mcp`; ikisi `~/.local/state/deckent-next-dev/mcp.json`). `mcp get` adsız genel hata; `mcp get filesystem` ham JSON. `add`, `add-json`, `import`, `remove`, `approve`, `revoke` yazdığı için çalıştırılmadı (yardım: sırlar `$DECK:AD`, içe aktarılan sunucu başlamadan onay ister).

**Bulgular:**
1. `list`/`get` insan modunda ham JSON.
2. Onay bekleyen sunucu (`filesystem`) yalnız JSON içinde `"status": "pending-approval"` ile görülür; sonraki adım (`deckent mcp approve filesystem`) yazılmaz.
3. Bağlantı durumu yok (Claude Code `claude mcp list` gösterir).

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent mcp` ve `mcp list` tablo: ad · kapsam · durum (güvenilir / onay bekliyor) · bağlantı · komut/URL; onay bekleyenler üstte ve sonraki adımla; JSON yalnız `--json`.
- Bağlantı kontrolü `--check` ile ve yalnız güvenilir sunucularda (güvenilmeyeni başlatmak risk; Claude Code'dan bilinçli fark).
- TTY: liste penceresi → sunucu → onayla / güveni geri al / kaldır → onay kartı (komut, realm, erişeceği araçlar).
- TTY `add` formu: ad, bağlantı türü, komut/URL. **Owner istisnası (10-08 seçim kuralına):** komut ve URL elle girilir, önizleme + onay kartı şartıyla. `import` yalnız seçimle (Claude Code/Desktop sunucuları listelenir).

## secret

**Ölçüm:** argümansız genel hata. `secret list` çalışır ama ham JSON (yalnız adlar, değer yok — doğru): `BACKUP_PASSPHRASE`, `DECKENT_ANTHROPIC_KEY`, `DECKENT_DEEPSEEK_KEY`, `DECKENT_OPENAI_KEY`, `DECKENT_OPENROUTER_KEY`; depo `core.secret-store.encrypted-file@1`. Argümansız `secret store` genel hata; `secret store --list` ham JSON (`env`, `file`, `encrypted-file` (şu anki)). `set`, `delete`, depo değiştirme yazdığı için çalıştırılmadı (değer yalnız stdin/gizli istem — doğru).

**Bulgular:**
1. `list` ve `store --list` insan modunda ham JSON.
2. Sırrı kimin kullandığı görünmez; silmeden önce etkisi bilinmez.
3. Depo türleri anlatılmaz (`file` düz dosya, daha güvensiz); `--confirm-downgrade` görülmeden güvenlik düşürme olduğu bilinmez.
4. `BACKUP_PASSPHRASE` yedeklenen kurulumun kendi deposunda; `doctor`'a göre açma anahtarı aynı klasörde. Makine/kurulum kaybında parola da gider.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent secret` ve `secret list` tablo: ad · kullanan (ör. "openai-api bağlantısı", "backup") · depo; değer asla; JSON yalnız `--json`.
- Argümansız `secret store` şu anki depo + seçenekler açıklamalı (`env` ortam değişkeni · `file` düz dosya, daha güvensiz · `encrypted-file` şifreli, açma anahtarı aynı klasörde).
- TTY: depo seçici, güvenlik düşüren seçimde ayrı uyarı kartı; `set` gereken adlar (ör. bağlı ama anahtarsız sağlayıcı) veya "yeni ad" + gizli istem; `delete` onay kartı kullananı gösterir.
- **Beta:** `doctor` ve `backup` "Yedek parolası bu kurulumun içinde saklanıyor; makine dışında da saklayın." uyarısı gösterir.

## toolchains

**Ölçüm:** argümansız genel hata. `toolchains update` (`--apply`'sız rapor) çalışır (0,8 s, çıkış 0): İngilizce özet satırı ("Toolchain update: planned; next version r18-20261018; image -; proposal -") + 157 satır ham JSON. İçerik: claude 2.1.302 → 2.1.303 eski; codex 0.163.0 güncel; cursor kullanıma alınmamış; plan `build` (yeni worker imajı r18). Config `toolchains.update.mode: auto`, derleme zaman aşımı 30 dk; otomatik derlemenin ne zaman yapılacağı doğrulanmadı. `--apply` Docker imajı derlediği için çalıştırılmadı.

**Bulgular:**
1. Rapor insan modunda ham JSON; özet İngilizce ve boş alanlı (`image -; proposal -`).
2. `--apply`'ın Docker imajı derleyeceği, 30 dk'ya kadar sürebileceği ve çalışan işlere etkisi söylenmez.
3. Otomatik güncellemenin açık olduğu görünmez.
4. `doctor --toolchains` ile örtüşme; ayrım: `doctor` sağlık, `toolchains` işlem.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent toolchains` durum tablosu (okuma, ağa çıktığı başta yazılır): araç · kabul edilen · en yeni · durum (güncel / eski / kullanıma alınmamış); altında "Otomatik güncelleme: açık — sıradaki imaj r18 (claude 2.1.303)"; TR.
- TTY `update`: plan kartı (ne değişir, yeni imaj, tahmini süre ve 30 dk üst sınır, çalışan işlere etkisi — kaynakta doğrulanıp yazılır) → onay → ilerleme.
- Pipe: tablo; JSON yalnız `--json`. Yardım `--apply`'ın Docker imajı derlediğini ve otomatik modu açıklar, `doctor --toolchains`'e yönlendirir.

## audit

**Ölçüm:** argümansız genel hata (çıkış 2). `audit verify` scope'suz çalışır (varsayılan `live`, 0,7 s, TR): "Audit live sonucu: eşleşiyor (uçtan uca doğrulandı)"; `--lang en` çalışır; ölçülen en temiz çıktı. `--export-checkpoint` son checkpoint'i tek satır JSON basar (sıra 36, head 2553, digest'ler, MAC; ayrı cihazda saklanmak için). `rebaseline` yazdığı için çalıştırılmadı (yardım: TTY y/N, AI reddedilir, gerekçe zorunlu).

**Bulgular:**
1. Argümansız `deckent audit` hata verir; `verify` zaten varsayılanla çalışır.
2. Checkpoint'in makine dışında saklanması gerektiği söylenmez; son checkpoint zamanı yalnız JSON'da epoch ms (`atMs`).
3. Yardım hizası bozuk ("rebaseline İncelenmiş…").
4. "Eşleşiyor" sonucunun sınırı (aynı hesaptan müdahaleyi tespit eder, önlemez) sonuç satırında yok.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent audit` = `verify`; altına "Son checkpoint: 2 gün önce (sıra 36)" ve "Bu doğrulama aynı hesaptan yapılan değişikliği yakalar, engellemez. Tam güvence için checkpoint'i makine dışında saklayın: `deckent audit verify --export-checkpoint > dosya`".
- `--export-checkpoint <dosya>` dosyaya yazar ve "kaydedildi: <yol>" der; yolsuz bugünkü gibi stdout.
- `rebaseline` güvenli davranışı korunur; TTY y/N yerine onay kartı, yeni temel olarak kabul edilecek şey kartta.
- Yardım hizası düzeltilir.

## inventory

**Ölçüm:** `--scope`'suz genel hata. `inventory --scope live` çalışır (İngilizce; `--lang tr` ile TR): "Stored execution records: 8…; canlı durum veya kabul edilmiş sonuç değildir" (dürüst). Satır: 64 hex run / görev / tam attempt UUID / sahip / çıkış / iptal / çıktı referansı; sonda "Next page: --after <uuid>". `--limit 100` İngilizce `DISPATCH_INVENTORY_LIMIT`, sınırı söylemez (config `inspection.maxPageSize = 64`).

**Bulgular:**
1. **Açık soru:** `inventory` bu scope'ta 8 yürütme kaydı, `workers list` 64 farklı attempt gösterir; farklı kaynaklar okunuyor olabilir, neden doğrulanmadı.
2. Sınır hatası değeri söylemez.
3. Ortak: ham kimlik, varsayılan scope yok, dil config'den okunmaz.
4. `run list` sonrası insan işi kalmaz; geliştirici/AI kayıt görünümü.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent inventory` varsayılan scope'ta (okuma); kısa kimlik; TR.
- Hata sınırı değeriyle söyler: "En çok 64; `--limit 64` kullanın."
- Yardım `workers` ve `run list` farkını bir cümleyle anlatır, insanı `run list`'e yönlendirir; geliştirici başlığında kalır.
- 8 / 64 farkı CLI-INSAN uygulamasında kaynakta incelenir; açıklanır ya da yanlışsa düzeltilir.

## paths

**Ölçüm:** argümansız çalışır (çıkış 0) ama insan modunda 36 satır ham JSON: layout revizyon hash'i, kök `.deckent/live-data`, 28 kaynak yolu. `paths --global` JSON, kök `~/.local/state/deckent-next-dev`.

**Bulgular:**
1. İnsan modunda ham JSON.
2. Yollar açıklanmaz (`fileEffects`, `instructionTrust`, `treeScanCache`); var/yok gösterilmez.
3. Soket çelişkisi: `paths` `.deckent/live-data/state/runtime.sock`, `doctor` `/tmp/dk-1000-af34…/s` (olası neden Unix soket yolu uzunluk sınırı; doğrulanmadı).
4. MCP tanım dosyası (`~/.local/state/deckent-next-dev/mcp.json`) ve gizli depo dosyası listede yok.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent paths` gruplu tablo: Yapılandırma · Kayıt ve veri · Güvenlik (audit, onaylar, gizli depo, yedekler) · Çalışma (soket, günlük) · Terminal; satır: TR açıklama · yol · var/yok.
- Proje ve global aynı çıktıda ayrı başlıkla; `--global` yalnız global.
- Soket: gerçekte kullanılan yol; mantıksal yoldan farklıysa ikisi ve neden.
- MCP tanım dosyası ve gizli depo dosyası eklenir. JSON yalnız `--json`, sözleşme aynı.

## runtime

**Ölçüm:** argümansız genel hata. `runtime describe` çalışır (çıkış 0), tek satır İngilizce: "Runtime service local, instance 9d934110-…; shutdown is configured and requires authorization." `--json`: `instanceId`, `identity {scopeId live, serviceId local}`, `build {sourceTreeSha256 71c248bf…, sourceCommit a4d2d444…}`, `processId`, `configDigest`, `autoStarted false`, `idleStopMs null`. `serve`, `shutdown`, `restart` canlı servisi etkilediği için çalıştırılmadı (`shutdown` servis + instance kimliği, command-id, gerekçe ister).

**Okunabilirlik doğrulaması (owner isteği):** sürüm/derleme evet (`describe` build = `deckent --version` derlemesi); yapılandırma güncelliği evet (`configDigest`, `doctor` `serviceConfig: current`); çalışan iş sayısı evet (`pool status`, servissiz); çalışma süresi **hayır** (`describe`'da başlangıç alanı yok; OS'tan okunur: süreç 3799421, 2026-10-18 14:19:47, ~13,5 sa; yalnız Linux `ps`); bağlı terminal oturumu **hayır** (alan bulunamadı).

**Bulgular:**
1. `describe` sürüm, süre, config güncelliği, çalışan iş söylemez.
2. `shutdown` insan için kullanılamaz (kimlikler `describe`'dan kopyalanır, command-id ve gerekçe zorunlu).
3. `restart`/`shutdown`'ın çalışan işlere ve bağlı terminallere etkisi yazılmaz.
4. `serve`'ün ne zaman elle çalıştırılacağı (normalde autostart) anlatılmaz.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent runtime` durum (okuma): "Çalışma servisi: çalışıyor · alpha.46 (a4d2d444) · 13 sa", "Yapılandırma: güncel", "Şu an: 0 iş çalışıyor", soket.
- `describe` sözleşmesine `startedAt` eklenir (`schemaVersion 2`); OS'a özgü okuma yok.
- TTY `shutdown`/`restart` onay kartı yalnız etkilenecek çalışan işleri gösterir (bağlı oturum sayısı beta sonrası ayrı sözleşme); gerekçe insan için isteğe bağlı (boşsa "Terminalden yeniden başlatıldı"), AI yolunda zorunlu; servis/instance kimliği sistemce.
- Yardım servisin normalde kendiliğinden başladığını, `serve`'ün elle ön plan için olduğunu söyler.

## coding

**Ölçüm:** argümansız genel hata. `coding template --provider codex|claude --kind coding --preview` ikisi de TR `CODING_TEMPLATE_TOOLCHAIN_REQUIRED` (çıkış 78): "Bu sağlayıcı ve imaj için tek bir kabul edilmiş CLI sürümü ve keşif seçimi yok…" — `toolchains` codex'i güncel ve kabul edilmiş gösterirken ve canlıda `native-coding-template-0b47…` profili kullanılırken. Kayıtsız sağlayıcı TR `CODING_TEMPLATE_INPUT_INVALID`, geçerli değerleri listelemez. `coding prepare` `{}` → İngilizce `EXECUTION_PROFILE_INVALID`; JSON biçimi yardımda yok. `--apply` config yazdığı için çalıştırılmadı.

**Bulgular:**
1. Geçerli sağlayıcı, `--kind` ve imaj (`sha256`) hiçbir yerde listelenmez.
2. Mevcut kodlama profillerini görmenin yolu yok.
3. **Açık soru:** `--preview` "toolchain yok" der, canlıda profil kullanılır; olası neden `--image` verilmeyince imaj belirsizliği, doğrulanmadı; sonraki adım söylenmez.
4. `prepare` JSON biçimi belgelenmemiş, hata İngilizce.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent coding` mevcut kodlama profilleri (okuma): ad · sağlayıcı · imaj (kısa) · kullanan görev türleri.
- TTY `template`: kabul edilmiş sağlayıcı → görev türü → kabul edilmiş imaj → önizleme kartı → onay; elle sha256 yok. Pipe'ta eksik değerde geçerli seçenekler hata mesajında.
- `CODING_TEMPLATE_TOOLCHAIN_REQUIRED` CLI-INSAN uygulamasında kaynakta incelenir; imaj belirsizliğiyse mesaj bunu ve kullanılabilir imajları söyler.
- `prepare` yardımda JSON alanları + örnek, `--schema`; hata TR ve eksik alanı adıyla.

## inference

**Ölçüm:** argümansız genel hata. `plan`, `budget`, `metrics` üçü de TR "Çözümlenmiş proje config'inde inference_serving tanımlı değil." (çıkış 0). Yerel vLLM sağlayıcı olarak tanımlı (`.deckent/config.json`: `local-vllm`, Qwen3.8-27B; `models` da listeler). `config get inference_serving` "bilinmeyen anahtar" (`--global` ile İngilizce), oysa kayıt defteri alanları tanır (`src/platform/core/config-fields/internal/choices.ts:223–225`); bölüm isteğe bağlı, yokken `config get` tanımaz.

**Bulgular:**
1. Mesaj dürüst ama sonraki adım yok (profil nasıl tanımlanır, neden gerekir, `local-vllm` sağlayıcısından farkı).
2. İsteğe bağlı config bölümü yokken `config` onu "bilinmeyen anahtar" sayar.
3. "Sağlayıcı olarak bağlı yerel model" (`models`) ile "yerel çıkarım sunucusu profili" (`inference`) farkı anlatılmaz.

**Kabul edilen hâl (owner 2026-10-19):**
- Argümansız `deckent inference` durum (okuma); profil yoksa: "Yerel çıkarım profili tanımlı değil. Yerel vLLM sağlayıcısı bağlı: Qwen3.8-27B (deckent models). Profil, vLLM başlatma argümanlarını ve kapasite tahminini üretmek için gerekir. Tanımlamak için: deckent config → inference_serving".
- `config` isteğe bağlı bölümleri tanır: `config get inference_serving` "tanımlı değil" der; TTY config seçicisi bölümü listeler ve profil seçimini sunar (`activeProfileId` zaten seçim referansı).
- Yardım iki kavramın farkını bir cümleyle anlatır.

## operation (lead önerisi; owner genel onayı 2026-10-19, tek tek sunulmadı)

**Ölçüm:** argümansız genel hata. Yardım iyi: koşullu yazım, idempotency, etkiden önce niyet kaydı, belirsiz sonuçta tekrar yok, onay gerekiyorsa `approval-pending` ve hiçbir şey gönderilmez, `--wait`. `config get operations` → `catalog: []`, `targets: []`: bu kurulumda tanımlı işlem ve hedef yok. `operation inspect --scope live --command-id yok-boyle` İngilizce "No recorded operation yok-boyle in this scope." **çıkış 0** (`run`'da bulunamayan kayıt çıkış 1). `operation execute` `{"schemaVersion":1}` → yanlış alanlı İngilizce "Invalid inventory query…" (`INVENTORY_QUERY_INVALID`, çıkış 2; `approval`'daki ile aynı). `execute`/`compensate` etki ürettiği için gerçek girdiyle çalıştırılmadı.

**Bulgular:**
1. Müşterinin ERP/CRM iş süreci yolu (north star) bu kurulumda boş ve komut bunu söylemez; boş katalogda sonraki adım yok.
2. Bulunamayan kayıt çıkış 0; diğer komutlarla tutarsız.
3. Geçersiz girdi hatası yanlış alandan (inventory), eksik alanı söylemez.

**Önerilen hâl:**
- Argümansız `deckent operation` katalog durumu (okuma): "Bu kurulumda tanımlı işlem yok (operations.catalog boş, hedef yok). Tanımlamak için: deckent config → operations"; katalog doluysa işlem · hedef · onay gerekir mi · telafi var mı tablosu. Yapılmış işlemlerin listesi owner M3 kararıyla beta sonrası ilk ERP kartıdır (PLAN Sıradaki 10); burada açılmaz.
- `inspect` bulunamayan kayıtta çıkış 1, TR.
- `execute`/`compensate` hata doğru alanı ve eksik alanı adıyla söyler; yardımda örnek, `--schema`.
- TTY `execute`: katalogdan işlem → hedef → şemadan parametre formu → önizleme kartı (hedef, etki, telafi var mı) → policy/onay → `--wait` davranışıyla aynı ekranda bekleme ve sonuç; onaydan sonra komutu elle yeniden göndermek gerekmez.

## terminal (lead önerisi; owner genel onayı 2026-10-19, tek tek sunulmadı)

**Ölçüm:** argümansız `deckent` PTY'de (120×40, tuşsuz 8 s) açılır: giriş kutusu ("Bir görev yaz · / komutlar · @ dosya"), alt durum çubuğu (`live · Qwen3.8-27B-INT4-W4A16 (local-vllm) · Hazır · ⏵⏵ tam otomatik · düşünme açık · bağlam ? · öz-kaynak zemini açık`), kısayol satırı, karşılama (proje, model, `/help`), "Runtime servisine bağlanıldı (9d934110-…)". Slash komutları tuş gerektirdiği için ölçülmedi. `terminal status` TR ve okunur (kurulum/proje kimliği, TTY yetenekleri, "inference_serving profili yapılandırılmamış", sohbet modeli `local-vllm/Qwen3.8-27B-INT4-W4A16@1`). `terminal chat-plan` insan modunda tek satır JSON (`status: ready`). `terminal snapshot` önce "inference_serving tanımlı değil", ardından genel `CLI_USAGE` (iki hata, çıkış 2). Sohbet modelinin (yerel vLLM) şu an erişilebilir olduğu doğrulanmadı.

**Bulgular:**
1. Durum çubuğunda "bağlam ?": bağlam penceresi bilinmiyor; olası neden `inference_serving` profili olmaması (doğrulanmadı).
2. `chat-plan` insan modunda ham JSON.
3. `snapshot` iki hata art arda, sonraki adım yok.
4. `terminal status` ve `chat-plan` "ready" der ama sohbet modelinin sunucusuna erişim sınanmaz.

**Önerilen hâl:**
- Etkileşimli terminal UX'i CLI-INSAN kapsamı dışında kalır: K1–K8, HARNESS-FARK ve beta kapısı 1 (owner terminal kabulü) altında yürür. Slash komutları bu incelemede ölçülmedi.
- `terminal status` sohbet modeli satırına erişim sonucunu ekler (ulaşılabilir / ulaşılamıyor / sınanmadı) ve bağlam penceresinin neden bilinmediğini söyler.
- `chat-plan` okunur özet; JSON yalnız `--json`.
- `snapshot` tek hata, nedeni ve sonraki adımı söyler.
