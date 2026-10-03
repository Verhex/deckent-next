# Yerel doğrulama ve kaynak sınırı

Yerel testler en fazla 16 GB kullanır; tam `npm run verify` varsayılan 4 worker, hedefli/şerit koşuları `VITEST_MAX_FORKS=2` kullanır (owner 2026-09-27; güncel AGENTS.md). Gerçek bellek ve eşzamanlı süreçler gözetilir, gerekirse doğrulama batch'lere bölünür. Bu makine sınırı ürünün worker veya müşteri kapasitesi değildir.

- Dilimlerde hedefli kontroller kullanılır; tam `npm run verify` yalnız geniş özellik ekleyen partilerde ve owner istediğinde koşulur (owner 2026-10-03). Hosted CI ayrı kapıdır; hedefli yerel sonuç hosted başarı değildir. Geçen kontrol sebepsiz tekrarlanmaz. Kaynak değişimi sonrası gerçek binary kanıtından önce build alınır.
- Aktif suite sırasında build alınmaz: dist/auth/cache karışması sahte sonuç üretir. Exit code doğrudan yakalanır; pipe'ın son komutu test başarısı sanılmaz. Legacy bot restart veya cleanup ritüeli uygulanmaz.

Legacy dersler: sınırsız fork sayısı yaklaşık 40 GB tüketerek WSL OOM/crash üretti (kaynak taşması, flaky test değil); 2026-08-26 beş-landing kadansı 21 dakikalık suite maliyetinden doğdu ve Next için geçerli değildir; eski vitest/heap sayıları güncel kanıt değildir.

CI-WINDOWS-MACOS dersi (owner 2026-10-01; exact kaynak tabanı `76582f9f`, dış kanıt `proof/CI-WINDOWS-2026-10-01/windows/`):
Windows `dirname` sürücü kökünde sabit nokta döndürür; yalnız `/`/`.` bitişi kullanan ata yürüyüşü iki Vitest worker'ını
senkron döngüde bırakmıştı. Sabit nokta bitişi Linux pin anlamını korur; negatif tekrar üretimi ayrı child'da OS
zaman aşımıyla sınırlanır. JS test timer'ı senkron döngüyü kesemez; hosted job sınırı dış kaynak korumasıdır,
ürün izolasyonu veya native platform kabulü değildir.

Aynı kartın Windows dosya dersi: `node:fs` O_NOFOLLOW/O_NONBLOCK Windows'ta bulunmaz; bitwise OR'da eksik bayrak
sıfıra dönüşür ve güvenlik garantisini sessizce düşürür. Dosya portu mevcut tipli ret ile erişimden önce kapanır;
stdin veya POSIX pozitif kanıt ayrı aktif kalır. JS timeout ya da koşullu assertion güvenlik yeteneği yerine geçmez.

Owner 2026-10-03: tam `npm run verify` her dilimde/partide koşulmaz; dilimler hedefli kontrollerle (typecheck, değişen dosyalarda eslint, lint-arch, dokunulan test dosyaları, gerekirse pano/host testleri) kapanır; tam verify yalnız geniş özellik ekleyen partilerde ve owner istediğinde koşulur (gece 2026-10-03: erken ve yanlış etiketli koşumlar zaman, token ve makine kaybı). Kaynak → neden → düzeltme → kanıt: tekrar eden tam koşumlar (≈10 dk, 4 worker, 16 GB) → kapı değeri düşük, maliyet yüksek → hedefli kapı + owner kararıyla tam verify → `proof/BATCH28-2026-10-03/README.md`.

CI-FIX-R2 dersi (owner 2026-10-03; hosted `37111243380`): her yeni veya yeteneği değişen test dosyası
altı OS×Node hücresinde taşınabilir davranışı doğrular ya da mevcut tipli platform yeteneğini açıklar;
desteklenmeyen pozitif varyant `verify-not-run` kaydı taşır ve erişim/etki öncesi tipli ret aktif testte doğrulanır.
Linux pozitifleri korunur. Yerel Linux PASS başka OS kabulü değildir; fixture güncel arch registry'sinin zorunlu
dosyalarını üretir. Bağımsız inceleme, yazar kontrolü ve hosted sonuç ayrı tutulur.

CI-FIX-R3 dersi (owner 2026-10-03; hosted `37129289264`, batch30 `56b2d43e`):
Additive gözlem (`RunView.pool`, doctor `poolReadiness`) immutable işlem makbuzuyla aynı byte sözleşmesi değildir;
Run'ın geri kalanı tam eşitlikte, gözlem ayrıca exact kontrolle korunur. SDK/policy/i18n değişimi yalnız
exact ekleriyle uzlaştırılır; geçmiş katalog hash'i yeniden üretilmez. Sabit 50/500ms test çıtaları makine
kalibrasyonundan bağımsız ürün garantisi sayılamaz: bağımsız CPU kontrolüyle loglanan, en fazla 10× test
kalibrasyonu ve deterministik NFA adım hesabı birlikte kullanılır; üretimin 5 milyon adım sınırı değişmez.
Windows delete-pending kilit dizini EPERM/EACCES'i sahipliğin bittiğini kanıtlamaz; metadata açma reddi gibi
sınırlı beklemedir. RED hata enjeksiyonu ve korunmuş sahiplik kanıtı native Windows kabulünden ayrıdır.
Exact patch, yerel sandbox açıkları ve lead'in kalan komutları dış `proof/CI-FIX-R3-2026-10-03/review.md`'dedir.
