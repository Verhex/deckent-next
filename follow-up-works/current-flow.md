# Anlık iş akışı — geçici

İş: INTEGRATION-INSPECTION. Durum: uygulandı; tam doğrulama ve gerçek kayıt yeniden okuma geçti; yerel commit için hazır.
Owner devam ve yerel commit izni verdi; push yapılmayacak. Tam doğrulama geçti; sıradaki onaylı bağımsız dilim PROVIDER-LIMITS-REMOVAL (O2).
DOGFOOD_MODE=OFF. Legacy salt okunur eski ürün; Fable kanalı kapalı, owner belge düzenlemesini yürütüyor.

## Son yayın ve mevcut WIP

f4d3bba1221d3f3fcd12a333f515243001386d50 commit/push tamam; origin/main eşleşmesi doğrulandı.
Yayın öncesi tam verify: 1508 ürün/261 dosya, native24, host30, atlanan0.
Ardından salt okunur integration-inspect uygulandı; bu değişiklikler ve son yol düzeltmeleri
yerel commit için doğrulandı. Sabit Docker imaj kimliğiyle full verify: 1510 ürün/261 dosya,
24 native, 30 host, atlanan0; lint/build/smoke geçti. İlk koşudaki etiket hatası
full-verify.log içinde korunuyor; başarılı koşu full-verify-pinned-image.log. Push yok.

## Çalışan inceleme

`task integration-inspect` exact identity + commandId ve güncel read-output policy ile
absent/pending/manifest-recorded gösterir. Public SDK aynı engine query servisine bağlı.
Ledger30 readonly; migration, Git çağrısı, source/candidate yazımı veya repair yok.
Execution config yokken ve source/candidate değişmişken geçmiş kayıt görülebilir.
Güncel candidate dosyaları yeniden doğrulanmadığı açıkça belirtilir; manifest artifact'i
ve scope/Run/Attempt bağı doğrulanır. Bu bilgi acceptance veya canlı teslim değildir.
Gerçek Codex/Claude/Cursor retained manifestleri SDK/CLI ile okundu; gerçek SIGKILL kaydı
pending görüldü; dosyalar korunuyor, yeni provider çağrısı0.

Kanıt: /home/alperen/deckent-refactor-work/proof/INTEGRATION-INSPECTION/.

## Belge alanı — son owner kararı

/home/alperen/deckent-refactor-work dış konumuna geri dönüldü. Next içinde refactor-work
klasörü veya symlink bırakılmadı. Dosyalar taşıma öncesi/sonrası hash ile doğrulandı;
hedef önceden mevcut değildi, Fable dosyası üzerine yazılmadı. Belgeler Git/npm dışında.
Skill/pointer/PLAN/aktif host planı geri yönlendirildi; Next core-memory otoritesi korunuyor.
Taşıma kanıtı: /home/alperen/deckent-refactor-work/proof/WORKSPACE-EXTERNAL-RESTORE/.

## Plan otoritesi ve sıradaki iş

Ana ürün iş alanları ve kalıcı kararlar: PLAN.md (EXECUTION / ISOLATION).
Mimari sözleşme: ARCHITECTURE.md. Bu dosya yalnız mevcut dar dilim ve kanıt takibidir.
Dış çalışma alanındaki tarihsel analiz/kartlar referanstır; kendiliğinden yürütme izni vermez.
Sonraki öneri: pending adaylar için tipli recovery sözleşmesi ve crash/ownership kanıtı.
Otomatik devralma/onarım ve canlı source landing henüz yok; yeni yazma sınırı kararı owner'a gelir.
Yeni recovery yazma sınırı için seçenek/kanıt hazırlanabilir; owner kararı olmadan devralma uygulanmaz.

## Dış refaktör alanı temizliği — owner onayı 2026-09-21

Dört kademe onaylandı; kanıt: /home/alperen/deckent-refactor-work/proof/CLEANUP-2026-09-21/manifest.json.
Yapıldı: 13 bayat kök belge hash'li `archive/superseded-2026-09-21.tar.gz` içine alındı (bayt doğrulamalı);
27 biten kart `cards/done/` altına taşındı (30 aktif kart kökte). Bekleyen: 13 asıl belge ve
`toolchains/{go1.27.1,go-cache,downloads}` silinmesi owner elinde (host sınıflandırıcı `rm`'i engelledi).
Go/LANG: TypeScript sürüyor; `lang/` ve `proof/LANG-*` gelecekteki ölçüm için korunur.

## Ürün modeli — yeniden değerlendirme

O4 owner tarafından yeniden açıldı; Run/Task/Attempt bütün Agent OS modeli sayılmıyor.
Üç alternatif ve solo/ekip/ERP yolculuğu taslağı:
/home/alperen/deckent-refactor-work/proof/AGENT-OS-MODEL-REVIEW/review.md.
Jev yalnız hazırlık yöntemine danışıldı; final mimari karar veya kapasite kanıtı değildir.
