# Anlık iş akışı — geçici

Owner dört işi art arda tamamlama izni verdi: O3 onay/rezervasyon, O6 canlı oturum,
güvenli worker teslimi ve gerçek çoklu worker. Jev north star + durum + seçeneklerle kullanılır.
Yerel commit var, push yok. Owner/Fable PLAN.md WIP'i değiştirilmez ve commitlenmez.

## Tamamlanan doğrulama

O3/O6: pending onay aday/pool slotu tüketmez; allow sonrası yeni commandId gerekir.
Eski rezervasyon replay genişlemez. Scope/policy/action bağlı MAC, kalıcı karar/receipt/outbox,
expiry ve açık renewal; CLI/MCP/SDK tek uygulama. Ayrı process/TTY/connection canlı session,
wall+monotonic kontrol; token-verified yalnız port. Pure launch değişmedi. Ledger31.
Tam verify: 1536 ürün/265 dosya,24 native,36 host geçti; sıfır skip/fail.
Gerçek servis: eşzamanlı CLI/MCP tek karar, eski replay korunuyor, yeni komut Docker işi çalıştırıyor.
Sınır: outbox notifier/uzak token doğrulayıcı/ayrı approval revocation yüzeyi henüz yok.

Üç gerçek native sağlayıcı geçici projede eşzamanlı çalıştı: Codex,Claude,Cursor exact dosya+patch,
network-none/geçit ve mount sınırları, host credential ve kaynak WIP korundu.
Ortak3 slot ikinci Run'ı bekletti; bağımlı join sonra başladı; gerçek iptal terminal oldu.
Bu bounded yerel kanıt; ölçek sertifikasyonu veya DOGFOOD açılışı değildir.

## Devam eden iş

Güvenli teslim: ayrı aday replacement, eski intent/bytes değişmeden link.
Doğrulanmış patch → deterministic Git commit → refs/deckent/deliveries altında create-only ref;
aynı ref transaction içinde kaynak HEAD kontrolü. Kaynak HEAD/index/WIP değişmez.
Canlı dala otomatik merge ayrı kapsam; teslim reference-only olarak açıkça adlandırılır.
Jev111d95ee-87e0-4e50-88db-f2fae4f01c58 önerdi; gerçek crash/replay/negatif kanıt bekliyor.
Önce kaynak bağlantıları ve testler, sonra saklanan üç native patch'i sağlayıcıyı yeniden çağırmadan teslim.
Son tam verify ve yerel commit sonrası dört madde sonuçları owner'a raporlanır.

Kanıt: /home/alperen/deckent-refactor-work/proof/FOUR-STEP-EXECUTION/.
DOGFOOD_MODE=OFF; legacy yürütülmez; Fable kanalı kapalı; bağımsız PASS iddiası yok.
