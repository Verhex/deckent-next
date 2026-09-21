# Anlık iş akışı — geçici

Owner seyahat sırasında onaylı işleri ilerletme ve yerel commit izni verdi. Push yapılmaz.
DOGFOOD_MODE=OFF; Fable kanalı kapalı; bağımsız Fable PASS iddiası yok.
Next tek yürütme/ürün repo'su; legacy salt okunur. Dış belge/proof alanı:
`/home/alperen/deckent-refactor-work` (Git/npm dışında; owner Fable ile düzenliyor).

## Doğrulanmış yerel dilimler

- ac44bc6: SDK/CLI salt-okunur integration-inspect; dış belge yoluna dönüş; O4 yeniden açık.
- 7188ed6: O2 uygulanmayan provider_limits kaldırıldı; O1 MEMORY satırı ve O1–O7 plan eşlemesi.
- 93f5ae1: O7 legacy sözleşmesinden statik yüzey envanteri; eski ürün çalıştırılmaz.
- Son dilim O5: owned/group-writable bootstrap/journal ancestry kabul, other-write ret;
  dosya uid/link/private-mode ve diğer kaynak güvenlik kontrolleri korunur. Yerel commit olarak teslim edilir; push yok.

Son tam `npm run verify`: 1517 ürün/261 dosya, 24 native, 34 host; atlanan0, hata0.
Sabit Docker imajı kullanıldı; lint/typecheck/arch/core-memory/build/smoke geçti.
O5 hedefli36 test ve gerçek SDK/CLI prova geçti. Linux kanıtıdır; fleet/enterprise yük kabulü değildir.

## Gerçek kanıt

- INTEGRATION-INSPECTION: Codex/Claude/Cursor retained manifestleri SDK/CLI eşit;
  SIGKILL pending kaydı korunuyor. Yeni native provider çağrısı0, kaynak/candidate yazımı yok.
- PROVIDER-LIMITS-REMOVAL: aynı config önce kabul, sonra CONFIG_VALIDATION/78; dosya değişmedi.
  Gerçek yerel HTTP fixture'larında kota ve harcama engelleri korundu; ücretli provider çağrısı yok.
- LEGACY-SURFACE-INVENTORY: 280 yol;269 CLI/39 MCP/41 REPL;11 yalnız REPL.
  Kaynak hash'i ve satırları manifestte. Eski282 sayımı düzeltilir; runtime/Next parity iddiası yok.
- INSTALLATION-GROUP-CUSTODY: 0775 projede SDK installed/CLI replayed;0600 journal aynı baytlar.
  0777 yazma isteği INSTALLATION_JOURNAL_UNSAFE; ürün dosyası yazılmadı. Host chmod yok.

Her klasör dış `proof/` altında verification.json ve ilgili günlük/gerçek sonuçları içerir.
İlk başarısız ortam/lint/proof varsayımı günlükleri saklandı; başarılı koşular açıkça ayrıldı.

## Ana plan ve sonraki kararlar

PLAN.md ana iş alanları/kararlar; ARCHITECTURE.md kabul edilmiş mimari otorite.
O1 ve O2 uygulandı; O5 dar bootstrap kapsamı doğrulandı; O7 envanter üretimi bağlı,
Next davranış eşlemesi açık. O3 approval/reservation ve O6 session freshness hâlâ açık.
Memory ana satırı eklendi; memory motoru tamamlandı iddiası yok.

Owner O4'ü yeniden açtı. Run/Task/Attempt bütün Agent OS modeli kabul edilmedi;
canonicalChain daraltılmadı. İnceleme taslağı:
`../deckent-refactor-work/proof/AGENT-OS-MODEL-REVIEW/review.md`.

Sıradaki integration recovery için A ayrı aday/kalıcı ilişki, B fenced yerinde onarım,
C mevcut manuel yol seçenekleri hazır:
`../deckent-refactor-work/proof/INTEGRATION-RECOVERY-DESIGN/review.md`.
Yeni recovery yazma/yetki sözleşmesi owner checkpoint'i bekler; pending takeover, cleanup,
canlı kaynak teslimi veya otomatik retry uygulanmadı. Jev tavsiye verdi; owner kararı değildir.

## Dış refaktör alanı temizliği — önceki koordinasyon kaydı

Owner/Fable düzenlemesi sırasında bu bölümün güncelliği yeniden doğrulanmadı.

Dört kademe onaylandı; kanıt: /home/alperen/deckent-refactor-work/proof/CLEANUP-2026-09-21/manifest.json.
Yapıldı: 13 bayat kök belge hash'li `archive/superseded-2026-09-21.tar.gz` içine alındı (bayt doğrulamalı);
27 biten kart `cards/done/` altına taşındı (30 aktif kart kökte). Bekleyen: 13 asıl belge ve
`toolchains/{go1.27.1,go-cache,downloads}` silinmesi owner elinde (host sınıflandırıcı `rm`'i engelledi).
Go/LANG: TypeScript sürüyor; `lang/` ve `proof/LANG-*` gelecekteki ölçüm için korunur.
