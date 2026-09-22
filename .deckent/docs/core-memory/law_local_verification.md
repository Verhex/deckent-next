# Yerel doğrulama ve kaynak sınırı

Yerel testler en fazla 16 GB kullanır; normal `VITEST_MAX_FORKS=2`. Gerçek bellek ve eşzamanlı süreçler gözetilir, gerekirse doğrulama batch'lere bölünür. Bu makine sınırı ürünün worker veya müşteri kapasitesi değildir.

- Landing öncesi `npm run verify` zorunludur. Değişiklik sırasında hedefli testler kullanılır; geçen kontrol sebepsiz tekrarlanmaz. Kaynak değişimi sonrası gerçek binary kanıtından önce build alınır.
- Aktif suite sırasında build alınmaz: dist/auth/cache karışması sahte sonuç üretir. Exit code doğrudan yakalanır; pipe'ın son komutu test başarısı sanılmaz. Legacy bot restart veya cleanup ritüeli uygulanmaz.

Legacy dersler: sınırsız fork sayısı yaklaşık 40 GB tüketerek WSL OOM/crash üretti (kaynak taşması, flaky test değil); 2026-08-26 beş-landing kadansı 21 dakikalık suite maliyetinden doğdu ve Next için geçerli değildir; eski vitest/heap sayıları güncel kanıt değildir.
