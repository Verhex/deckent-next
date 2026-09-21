# Yerel test kaynak sınırı

Kapsam: ürün ilkesi / Next geliştirme uygulaması. Owner normalizasyonu: 2026-09-21.

Legacy sınırsız fork sayısı yaklaşık 40 GB tüketerek WSL OOM/crash üretti; bu flaky test değil kaynak taşmasıydı. Yerel testler en fazla 16 GB; normal VITEST_MAX_FORKS=2. Gerçek bellek ve eşzamanlı süreçleri gözet, gerekiyorsa doğrulamayı batchlere böl. Eski vitest ayarları/heap sayıları güncel uygulama kanıtı değildir. Bu makine sınırı ürünün worker veya müşteri kapasitesi değildir.

Tarihsel kaynak: bu dosyanın normalizasyon öncesi Git geçmişi; eski komut ve durumlar güncel yetki değildir.
