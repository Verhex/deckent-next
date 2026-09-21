# Provider kapsamlı model seçimi

Kapsam: ürün ilkesi / Next geliştirme uygulaması. Owner normalizasyonu: 2026-09-21.

Provider ve scope bazında açık etkinleştirme sınırı korunur. Varsayılan tercih izin değildir; katalogda yeni model belirmesi otomatik activation yapmaz. İnaktif/erişilemez modelde sessiz ikame veya yeniden etkinleştirme yok; açık sonuç ve yetkili seçim gerekir. Legacy ModelActivationStore/models.db bir Next uygulama iddiası değildir. Somut model ve provider durumu registry/config ve gerçek erişimden doğrulanır.

Tarihsel kaynak: bu dosyanın normalizasyon öncesi Git geçmişi; eski komut ve durumlar güncel yetki değildir.
