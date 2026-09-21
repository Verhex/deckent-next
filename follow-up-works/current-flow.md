# Anlık iş akışı — geçici

İş: PATCH-INTEGRATION. Durum: owner onaylı A uygulandı ve yerel gerçek kanıt/tam verify tamamlandı.
Bağımsız review yapılmadı; Jev tavsiyesi review/acceptance yerine geçmez.
DOGFOOD_MODE=OFF. Legacy yalnız okunabilir referans; Fable kanalı kapalı.
HEAD 7f02a49; mevcut tasarım WIP'si korundu. Owner commit/push istedi; yerel refaktör alanı Git/npm dışında tutularak yayın hazırlanıyor.

## Çalışan yol

`task integration-check` → exact patch + source/base/HEAD + dokunulan index/worktree
kontrolü → kısa öneri kodu. `task integration-prepare --command-id … --proposal …`
aynı kimlik bayraklarıyla ayrı aday hazırlar. CLI ve public SDK tek engine servisine bağlı;
MCP/Desktop/HTTP ve otomatik scheduler/acceptance bu dilime dahil değil.

read-output yanında ayrı prepare-integration policy gerekir. Ledger30 scope+commandId,
actor, exact attempt, patch receipt ve observation bağını ilk aday etkisinden önce tutar.
Yalnız kazanan işlem yeni, özel dizin oluşturur. Git broker detached/no-hardlink clone'u
`<configured workspaces>/integrations/<command digest>/<attempt digest>/tree` altında
ayırır. Worker checkout'u yeniden kullanılmaz. Dosya yazımı descriptor-relative/no-follow
ve exclusive create kullanır. Beklenen snapshot iki okumayla, kaynak/policy tekrar kontrolüyle
manifest artifact'ine bağlanır. Kaynak HEAD/index/WIP yazılmaz; aday canlı WIP'yi içermez.

Tamamlanan komut güncel yetki, kaynak, manifest ve aday dosyalarını yeniden doğrular.
Kesilmiş komut PATCH_INTEGRATION_PENDING verir; dosyaları/intent'i korunur, otomatik
devralma/onarım/cleanup yoktur. Bu güvenli duruş tam recovery capability'si değildir.
Normal prepare migration yapmaz; eski ledger explicit storage/installation migration ister.
Eski sürüm test fixture'ları yeni tabloyu gerçekten çıkaracak şekilde güncellendi.

## Kanıt

Proof kökü: /home/alperen/deckent-next/refactor-work/proof/PATCH-INTEGRATION/

- live-results.json: Codex, Claude, Cursor mevcut gerçek native patch'leri sırayla ürün
  SDK check → compiled CLI prepare → SDK replay yolundan geçti. Exact dosyalar ve source
  HEAD/index/WIP korunması üçünde doğrulandı. Yeni sağlayıcı çağrısı/token kullanımı yok.
- crash-result.json: gerçek hazırlayıcı süreç candidate verify sonrasında SIGKILL ile
  durduruldu. Manifest yayımlanmadı; dosyalar korundu; gerçek SDK tekrarı pending ile durdu.
- targeted.log: ilk 3 entegrasyon testi geçti (filtrelenen 13 eski test bu koşuda atlandı).
  İlk denemede public SDK export eksikliği yakalanıp düzeltildi; eski 13 patch testi geçti.
- workspace-patch.test.ts: CLI/SDK, edit/add/delete/mode, index/WIP/HEAD, scope/policy,
  symlink/hardlink, command yarış/replay, manifest bozulması, araya giren owner yazısı ve
  finalization kesintisi. Bu dosyadaki 17 test tam verify içinde geçti.
- verify.log: npm run verify geçti; 1508 ürün/261 dosya, native24, host30, atlanan0.
  Lint/typecheck/arch/build/smoke geçti; 26 canonical memory dosyası aynı.
  İlk full koşuda yalnız CLI yardım beklentisi eksikliği yakalandı (1507 geçti/1 hata);
  eski oracle korunarak beklenen bilinçli metin güncellendi, hedefli3 ve tam koşu geçti.

## Jev ve sınırlar

Tasarım: ae2580f5-0c43-42f1-8d67-4b8d9dde8017, A .97; owner A'yı onayladı.
Uygulama sınırı: 070172c7-bf68-4936-be12-3080a3faf66c, verify_conservative .97,
expand_resume 0, none_of_the_above 0, insufficient_information .03; abstention seçimleri
ayrı 0/0. Context sufficiency .43; bu tavsiye kabul/bağımsız review kanıtı değildir.
Decision ve evidence-bound outcome kaydedildi; probabilistic cevaplar için yapay
boolean doğruluk etiketi üretilmedi.

Manifest, patch'in korunan yol istisnaları dışındaki dosya snapshot'ını doğrular;
Git metadata bütünlüğü veya aynı OS kullanıcısının dış süreçlerine karşı fencing iddiası yok.
Hazır aday test başarısı, görev kabulü veya canlı teslim değildir. Kısmi aday için tipli
inspection/recovery ve son fenced landing açık. Mevcut tekil provider HTTP unknown bulgusu
açık kalır; bu dilimde yeni native çağrıyla geniş teşhis yapılmadı.

## Sonraki adım

Değişen dosyalar/kanıt/sınırlar owner raporuna hazır; HEAD 7f02a49 değişmedi.
Sonraki dar dilimde pending aday inspection/recovery ve test/kabul/son teslim
bağını ayrı işler olarak ele al. Yeni kaynak yazma sınırı mevcut A onayından türetilmez.


## Next yerel refaktör alanı — owner 2026-09-21

`refactor-work/` tamamıyla Next içine taşındı; 17437 dosya/379156971 bayt taşımada
hash ile doğrulandı, önceki kardeş dizin kaldırıldı (yönlendirme/symlink yok).
Owner ek talimatıyla klasörün tamamı Git ve npm dışında. Araç zinciri, dokümanlar,
kanıtlar ve asıl bayt arşivi yerel olarak korunur. 162 metin yol kopyası güncellendi;
yeni yol kopyası yeni koşu kanıtı değildir, eski hash'ler arşivlenen asıllara aittir.
Skill/pointer/PLAN ve aktif host planı güncellendi; hook'larda eski çalışma yolu yok.
Next kendi canonical core-memory'sini manifest ile doğrular; legacy'ye yazılmaz.
Taşıma kontrolü: refactor-work/proof/WORKSPACE-CONSOLIDATION/checks.json.
Yayın öncesi npm run verify geçti: 1508 ürün/261 dosya, native24, host30, atlanan0.
Next canonical memory manifesti 26 dosyada doğrulandı; legacy eşitliği artık gerekmiyor.
Commit/push owner tarafından istendi; tam SHA ve uzak eşleşme Git/proof kaydından okunur.
