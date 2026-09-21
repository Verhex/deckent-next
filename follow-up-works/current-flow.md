# Anlık iş akışı — geçici

İş: NATIVE-PATCH-PREVIEW. Durum: PLANNED; uygulama başlamadı. DOGFOOD_MODE=OFF.

Sonuç hedefi: izole worker değişikliğini, doğru kaynak/base/attempt kimliğine bağlı,
kalıcı ve sınırlandırılmış patch artifact'ı olarak hazırlayıp SDK/CLI'dan incelemek.
Ana çalışma alanına uygulama ve otomatik merge bu dilimin parçası değil.

## Neden sırada?

Codex, Claude ve Cursor ortak image/profile/abonelik/geçit yolunda gerçek küçük dosya
editi yaptı. İsimli çıktı artifact'ı doğrulanıyor; bütün değişikliklerin güvenli teslim
paketi henüz yok. PLAN'ın canlı teslim işine ilk küçük adım bu paketin hazırlanması.
Mevcut GitWorkspaceBroker sourceFingerprint, baseCommit ve attempt lease sağlıyor;
assertSourceBase kaydedilen commit'i doğrular, güncel hedef HEAD/içerik koşulunu değil.
Legacy ADR-G-037 checkpoint/terminal sonuç ayrımı için kaynak; bütçe devam mekanizması
ve eski runtime bu dilime taşınmayacak. Patch hazırlamak görev kabulü/teslim onayı değildir.

## Sınır ve sahiplik

- Sağlayıcıdan bağımsız tek sözleşme: engine hazırlama kuralları/port; Git adapter sınırlı
  değişiklik okuması; composition mevcut policy, attempt custody ve artifact depolamayı
  bağlar. SDK/CLI aynı uygulama yolunu kullanır. Ayrı scheduler/approval sahibi yaratılmaz.
- Yalnız durduğu doğrulanan, doğru attempt'e ait workspace işlenir. Worker'ın yazabildiği
  .git/config, hooks, attributes veya diff sürücülerine güvenilmez; host-owned base ve
  güvenli okuma yolu gerekir. Çıktı base/source/attempt, dosya değişiklikleri ve içerik
  digest'lerini bağlar; schemaVersion açık olur. Kesin şema uygulama başında netleştirilir.
- İlk kapsam sınırlı normal dosya ekleme/değiştirme/silme. Untracked dosya açıkça ele alınır;
  symlink, özel dosya, submodule, binary/limit aşımı desteklenmiyorsa sessiz eksiltmeden reddedilir.
  Rename ilk sürümde ekleme+silme olarak temsil edilebilir. Metadata/kimlik dosyaları hariçtir.
- Preview kaynak ağacını değiştirmez ve uygulanabilirlik garantisi vermez. Hedefe koşullu
  uygulama, hedef değişikliği/yarış ve kısmi uygulama kurtarması ayrı sonraki dilimdir.
  Ağ/kimlik sınırı, timeout/kaynak limiti, iptal ve custody sözleşmeleri korunur.

## Kabul kanıtı

1. Gerçek geçici Git workspace'te edit/add/delete → uygulama → kalıcı artifact → SDK/CLI
   preview; byte/digest/base/attempt eşleşmesi, kaynak çalışma ağacının değişmediği kanıtı.
2. Yanlış scope/attempt, çalışan worker, bozuk artifact ve oynanmış workspace metadata reddi;
   path kaçışı, symlink ve boyut sınırı negatifleri. Host hook/diff komutu çalışmamalı.
3. Tekrarlı hazırlama aynı snapshot için aynı sonucu verir; değişen snapshot eski receipt'e
   bağlanmaz. Yarım yazma/restart ve artifact okuma yetkisi mevcut sahiplikle doğrulanır.
4. Üç sağlayıcının aynı hazırlama yolunu kullandığı gösterilir; yeni gerçek native çağrı
   gerekirse aynı küçük geçici senaryo sırayla çalışır. Token içeriği kanıta yazılmaz.
5. Hedef HEAD/WIP değişse bile preview bunları korur; güvenli apply tamamlandı denmez.
   İlgili kontrat testleri, gerçek Git/surface kanıtı ve npm run verify gerekir.

## Karar ve açıklar

Jev 085ac8e0-ad65-45c9-9adb-b3c7c4f9566e: patch_preview 0.87,
model_admission 0.11, event_usage 0; none_of_the_above 0.01 (seçilmedi),
insufficient_information 0.01 (seçilmedi). Öneri kanıt/izin değildir; seçilen plan
mevcut artifact ve kaynak kimliğini kullanarak incelenebilir teslimi ilerletir.
Uygulama doğrulanmadığı için Jev outcome henüz yok. Yeni güven sınırı gerekirse somut
seçeneklerle owner'a getirilir. Model active-set admission, native olay/usage, refresh,
MCP preparation ve DOGFOOD kabulü açık; bu plan onları tamamlanmış saymaz.
Fable kanalı kapalı; bağımsız PASS iddiası yok.

Önceki dilimin gerçek kanıtı:
/home/alperen/deckent-refactor-work/proof/NATIVE-CODING-AUTH-NETWORK/
