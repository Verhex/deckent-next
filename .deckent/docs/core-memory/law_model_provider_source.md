# Model ve provider tek kaynaktan

Model adı, fiyat, kapasite ve değişebilir iş politikası registry/config üzerinden çözülür; kod yolunda literal yasaktır (ADR-G-036 + ratchet). Kaynak, güncellik ve offline sınırlama görünür olmalıdır; eksik veri sıfır veya güncel başarı sayılmaz. Air-gap için kontrollü snapshot desteklenir. Sabit güvenlik/protokol kuralı sürümlü kodda kalabilir; her literal için abstraction kurulmaz.

- Provider-scoped explicit-active: `default_model` tercihtir, sert sınır owner active-set'idir. Katalogda yeni model belirmesi otomatik activation değildir. İnaktif/erişilemez modelde sessiz ikame veya yeniden etkinleştirme yoktur; açık sonuç ve yetkili seçim gerekir. Legacy ModelActivationStore/models.db Next uygulama iddiası değildir.
- Görev-model eşlemesi: belirsiz ve yetki açısından kritik iş kanıtlanmış üst kapasiteyle eşlenir; rutin iş gereksiz maliyetle büyütülmez. Tarihsel sol/opus/sonnet sırası evrensel değildir; bu kayıt subagent başlatma izni değildir.
- Provider ortamı: tarihsel login veya model listesi güncel erişim kanıtı değildir. Codex/Claude/Cursor aynı adapter/izolasyon sınırında güncel sürüm, profil, auth ve gerçek denemeyle doğrulanır. Host HOME, Docker socket veya alakasız credential açılmaz; token config/proof/çıktıya yazılmaz.

Legacy dersler: Sprint-206 eski bundled model adını güncelmiş gibi gösterdi (fetch/cache/fallback kaynağı görünmüyordu); Sprint-554 kritik runtime işini zayıf modele, test işini güçlü modele verince risk/kapasite eşlemesi bozuldu; 2026-08-19 Cursor CLI login kaydı yalnız tarihsel ortam kanıtıdır.
