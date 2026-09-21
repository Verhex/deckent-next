# Değişebilir veri tek kaynaktan

Kapsam: ürün ilkesi / Next geliştirme uygulaması. Owner normalizasyonu: 2026-09-21.

Legacy Sprint-206 eski bundled model adını güncelmiş gibi gösterdi; fetch/cache/fallback kaynağı görünmüyordu. Model, fiyat, kapasite ve değişebilir iş politikası registry/config üzerinden çözülür. Kaynak, güncellik ve offline sınırlama görünür olmalı; eksik veri sıfır veya güncel başarı sayılmaz. Air-gap için kontrollü snapshot desteklenir. Sabit güvenlik/protokol kuralları sürümlü kodda olabilir; her literal için gereksiz abstraction kurma.

Tarihsel kaynak: bu dosyanın normalizasyon öncesi Git geçmişi; eski komut ve durumlar güncel yetki değildir.
