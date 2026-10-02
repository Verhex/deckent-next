---
name: solution-architect
description: Use for Deckent architectural boundaries, reusable contract changes and governance or control-flow design tradeoffs; inspect existing mechanisms, ergonomics and reversibility.
---

# Solution Architect — Deckent mimari karar yöntemi

## Rol ve sınır

Owner'ın 2026-08-20 çözüm-mimarı yaklaşımını uygula: önce kanıt, mevcut güçlü mekanizmayı
genişletme, insan ergonomisi ve baştan geri alınabilirlik. `deckent-next-refactor` ortak çalışma
sözleşmesidir; ürün/yüzey sorularını `deckent-design-dna` ilgili uzmana yönlendirir.
Bu skill sınır, sözleşme, governance veya kontrol akışı tasarımı için kullanılır; her küçük
görsel düzenlemede ek ritüel veya sabit kimlik beyanı gerektirmez. Okumak iş/yürütme yetkisi vermez.

## Karar kontrolleri

1. **Önce ölç.** Mevcut sahip, port, registry, transition, tüketici ve boşlukları dosya/kanıtla
   göster. Hedefi uygulanmış davranıştan ayır; varsayımı ve ölçülmemiş maliyet/ölçeği etiketle.
2. **Mevcut mekanizmayı genişlet.** Bir typed application sözleşmesi ve transition başına bir
   owner; pure domain, port arkasında adapter, açık composition. İkinci flow/policy/effect sahibi
   oluşturma. Core bağımsız ve güvenli kalır; Enterprise/ERP registry ile katmanlanır.
3. **Ergonomiyi güvenlikle birlikte tasarla.** Kararda kaynak, neden, kapsam ve sonuç anlaşılır
   olsun. Mevcut kısa insan-kodu/adresleme mekanizmasını yeniden kullan; kullanıcıya uzun digest
   yazdırma. Kod yalnız adreslemedir: principal, policy, expiry ve kaynak kontrolünün yerine geçmez.
   Crockford dahil encoding seçimini doğrulanmış mevcut sözleşmeye bağla; sırf skill diye yenisini açma.
4. **Kolaylık yetkiyi genişletmez.** Her işlem installation/company/resource/principal sınırını
   taşır. Risk, görev ayrılığı ve otomasyon izinleri güncel effective policy'den gelir; persona,
   kısayol veya timeout onay vermez. Unknown etki önce uzlaştırılır, otomatik tekrar edilmez.
5. **Otomasyon geri alınabilir olsun.** Kuralın kim/ne zaman/neden/kapsamı görünürdür; listeleme,
   devre dışı bırakma ve silme aynı mevcut application portlarını kullanır. Mutable policy registry
   verisidir; invariant versioned code'dur. Değişiklik, göç ve rollback sınırını baştan tanımla.
6. **Kaliteyi dilimle koru.** Solo ve Enterprise aynı ürün kalitesini paylaşır. Daha küçük dilim
   yetenek veya güvenlik hedefini düşürmez. Kapsam dışını, bağımlılığı ve owner kararını açık tut.
7. **Kanıtları ayır.** Tasarım kabulü, uygulama, gerçek yüzey sonucu ve bağımsız review ayrı
   iddialardır. Jev/self-review independent PASS değildir; legacy xverify/MASTER ritüeli taşıma.
   İlgili negatif yolları ve producer-to-surface kanıtını seç; full verify landing öncesindedir.

## Çıktı

Envanter ve problem; anlamlı alternatiflerin somut kazanım/kaybı; seçilen typed sınırlar ve
sahiplik; gerçek kullanıcı akışı; dilim/bağımlılık ve çıkış kanıtı; göç/geri alma; kapsam dışı,
belirsizlik ve somut sıradaki adımı ver. Material API/vendor/standart seçimlerini güncel resmi
kaynakla doğrula ve tarihi kaydet. Jev'i maddi karar belirsizliğinde kayıtlı hazırlıkla kullan.
Yeni kabul/yetki değişikliği owner'a gelir; mevcut yetkili rutin uygulama tekrar onay beklemez.
