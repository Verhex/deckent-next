---
name: feedback-verification-cadence
description: Bir değişiklikten sonra neyi ne sıklıkta koşarım — full suite 5 landing'de bir (Alperen 2026-08-26), kaynak değiştiyse build zorunlu, suite koşarken build yasak
metadata:
  type: feedback
---

İki kural tek soruyu cevaplar: *bir değişiklikten sonra neyi, ne zaman koşarım?*
(Birleştirildi 2026-09-20: `feedback_full_suite_cadence` + `feedback_build_after_source_change`.)

## 1. Full suite kadansı — 5 landing'de bir

Full vitest suite'i her landing sonrası koşma; **5 landing süreci sonrasında bir** koş
(Alperen 2026-08-26 gece amendment'i: "çok vakit kaybettiriyor, 5 turda 1 koşalım" — önceki
3-landing kadansı 2026-08-19). Aradaki landing'lerde scoped/hedefli testler + 20-gate lint +
`tsc --noEmit` yeterlidir. Sayaç SIFIRLANDI: 2026-08-26 13:5x sertifika-koşumu
(2830 dosya / 38.842 yeşil; 3304-kanıtı) = son koşum.

**Why:** Full suite'in ölçülen maliyeti ~21 dk/koşum (38,7k test; 2026-08-26 gecesi 4 koşum ~80+ dk).
Aynı gece full-suite gerçek bir **206-kırmızı regresyon dalgasını** yakaladı — kadans seyreltildi ama
sıfırlanmadı; gate'ler + scoped koşumlar aradaki güvenlik ağıdır.

**How to apply:** Landing checklist'inde "full suite" adımını landing-sayacına bağla.
[[feedback_vitest_16gb_local_cap]] limitleri (VITEST_MAX_FORKS=2, ≤16 GB) aynen geçerli.
Verdict'i **pipe'sız exit-code** ile yakala ([[feedback_disk_evidence_before_claims]] — pipe son
komutun kodunu döndürür; aynı tuzak 2026-08-26 gecesi iki kez bağımsız üretildi).

## 2. Kaynak değiştiyse build zorunlu

Sprint (dogfooding) veya el-kodu sonrası kaynak kod değiştiyse ve süreç tamamlandıysa MUTLAKA build
alınır: "build almazsan eklenen özellikler kendisini dogfooding'de doğru şekilde gösteremez;
dist=src olarak yürüyeceğiz — src değişince tekrar build." (Alperen, 2026-08-21.)

**Why:** Dogfooding `dist/`'ten koşar; build alınmazsa yeni landed özellikler sonraki koşularda
görünmez — dist-src drift'i **sessiz yanlış-davranış** üretir (`DECKENT_BINARY_IDENTITY_WARN` bunun sinyalidir).

**How to apply:** Döngü: kod wired+landed → build → dogfooding/el-kodu devam.
Build sonrası bot/MCP restart ritüeli. Clean adımı HOLD verirse (bot aktif / xv-artığı):
bot-stop → xv-arşiv-taşıma → build → bot-start.

## 3. İki kuralın kesiştiği yer — suite koşarken build YASAK

Sprint/suite KOŞARKEN build alınmaz (ESM-cache + worker auth-loss); build koşumlar arasında alınır.
dist-integrity teardown'ı orta-koşu build'ini `HermeticDistIntegrityError` ile düzgünce yakalar.

---
**⚠ Eskimiş referans (2026-09-20 ölçüldü, silinmedi):** `npm run build:all` **legacy `deckent-dev`'de var,
`deckent-next`'te YOK.** Next'in scriptleri: `build · typecheck · lint · test · test:e2e · smoke ·
verify · test:native · test:host`. Next'te bu kural `npm run verify` (veya `npm run build`) karşılığıyla
okunur. Kural geçerli; komut adı repo-bağımlı.
