# Yerel doğrulama ve kaynak sınırı

Yerel testler en fazla 16 GB kullanır; tam `npm run verify` varsayılan 4 worker, hedefli/şerit koşuları `VITEST_MAX_FORKS=2` kullanır (owner 2026-09-27; güncel AGENTS.md). Gerçek bellek ve eşzamanlı süreçler gözetilir, gerekirse doğrulama batch'lere bölünür. Bu makine sınırı ürünün worker veya müşteri kapasitesi değildir.

- Landing öncesi `npm run verify` zorunludur. Değişiklik sırasında hedefli testler kullanılır; geçen kontrol sebepsiz tekrarlanmaz. Kaynak değişimi sonrası gerçek binary kanıtından önce build alınır.
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
