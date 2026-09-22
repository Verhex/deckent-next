# Anlık iş akışı — worker prompt kompozisyonu

## Son teslim ve mevcut doğrulama

Baz cef8457 native discovery profilini teslim etti; önceki checkpoint923e5a2 push edilmişti.
Owner şimdi legacy ortak worker prompt kompozisyonunu Next'e alma dilimini onayladı.
DOGFOOD_MODE=OFF; Fable kanalı kapalı; bu dilimde push yok. Önceki belge WIP'i korundu.

Native authoringv2 raw prompt veya composition-v1 alır. Tek sürümlü common-core kataloğu;
açık persona/skill/context seçimi + görev/kapsam/kabul, içerik/argv hash'leri aynı hazırlanmış
profili kullanır. Tam katalog, otomatik skill seçimi veya yeni yürütme otoritesi açılmadı.
Claude core'u system-prompt, Codex özel tmpfs instructions-file, Cursor inline alır.
Worker hash kontrolünden sonra yerel argümanları doldurur; native process spawn olduğunda
mevcut Attempt çıktısına yalnız hash/kimlik/sürüm receipt'i yazar. Bu model uyumu değildir.
Unicode bootstrap parçaları UTF-8 decoder ile birleştirilir; secret/prompt gövdesi loga çıkmaz.

Son derlemede sıralı Codex/Claude/Cursor koşumları dört ayrı katmandaki rastgele değerleri
note.txt dosyasına tam yazdı; değerler görev metnine veya workspace fixture dosyalarına sızdırılmadı;
üçünde tek-dosya patch, receipt hash/selection eşliği ve terminal replay doğrulandı.
Host credential dosyaları, fixture kaynak HEAD/index/WIP korundu; network none ve kapalı
mount sınırı korundu. Default core ile ilk üç koşum da dosya işini geçti; kanıt betiğindeki
JSON alan sırası karşılaştırması false-negative verdi. Kayıt korundu; alan bazlı karşılaştırma
ile ayrıştırıldı. İkinci üç koşum core içindeki özel talimatı da test etti; hepsi geçti.
İlk 40 sözleşme testi ve tam verify geçti: **1556 ürün/265 dosya,25 native,44 host; fail/skip0**.
Lint/build/smoke geçti. Son UTF-8 decoder düzeltmesi gerçek Docker testinde Türkçe/emoji
ile ve ardından son derlemedeki üç native denemeyle doğrulandı. Toplam dokuz owned worker
temizliği Docker envanterinden kontrol edildi. Ürün kaynakları tam suite sırasında sabit tutuldu.

Keşif sınırı ayrı: Claude disabled/safe-mode; Codex/Cursor açık repository istisnası sürer.
Codex project_doc_max_bytes=0 yalnız proje dokümanı otomatik yüklemesini hedefler; tüm hook/MCP
kapalı iddiası yok. Prompt persona/skill yetki vermez; auth/API/ücret fallback'i eklenmedi.

Kanıt: /home/alperen/deckent-refactor-work/proof/NATIVE-PROMPT-COMPOSITION-2026-09-22/
(review.md, verification.json, profile-live.json/mjs, cleanup-check.json, full-verify.log).
Legacy kaynak analizi: dış proof/LEGACY-PROMPT-COMPOSITION-2026-09-22/review.md; legacy salt okunur incelendi, çalıştırılmadı.
Jev273914c5 mevcut profil üzerinden dar kompozisyon yolunu %99 önerdi;
none0/insufficient%1, her iki abstention seçimi0/1. Karar ve bounded verified outcome kaydı var; yeni ürün kabulü anlamına gelmez.
Jev/kendi doğrulamamız bağımsız Fable PASS'i değildir. README/ARCHITECTURE/PLAN/CHANGELOG güncel;
AGENTS/CLAUDE52 satır; kalıcı ilke değişmedi, bu dosyalara gereksiz iş geçmişi eklenmedi.

## Sıradaki sıra

1. A02/W0-3 süre/bekleme/doğrulama/rework ölçümünü M1–M5 tarih güncellemelerine bağla;
   gözlenmeyen süreyi tahminle doldurma, commit sayısını efor yerine koyma.
2. N/N+1 kabul/kurtarma: mevcut çalışma kaydı ve kayıp/yeniden başlama sınırından ilerle;
   genel tool/approval, Mission veya Enterprise yüzeylerini gereksiz dogfood kapısı yapma.
3. Codex/Cursor tam discovery-off ve daha geniş explicit settings yalnız kendi gerçek kanıtıyla
   desteklenmiş capability olur; mevcut açık repository istisnası kapatma kanıtı sayılmaz.

Kabul edilen plan değişmez: D15a Mission author D14 sonrası; D15b do D14'ten bağımsız.
H34 company scope; Core company/RBAC M2 öncesi, IdP/SIEM M4. Process operasyon kataloğu ve
mevcut yürütme/Mission şablonlarını kullanır; üçüncü motor yok. Yeni yetki sınırı somut seçenekle
ownera gelir; mevcut worker izinleri tekrar sorulmaz. Önceki dört execution diliminin kanıtı
FOUR-STEP-EXECUTION'dadır; önceki bare karşılaştırması NATIVE-BARE-COMPAT-2026-09-22'dedir.

## Ayrı sahipli Cursor hattı ve host araçları

Cursor localLLM/terminal: /home/alperen/deckent-next-wt-local-llm, feat/local-llm-terminal,
başlangıç652d1c2. Bu worktree değiştirilmedi/merge edilmedi; main'in ortak arch/config/CLI/i18n
kaynaklarında paralel uygulama açılmadı. Exact commit/diff ve gerçek paralel koşum kanıtı geldiğinde
ortak kaynaklar tek yazarlı birleşir, güncel PLAN'a eşlenir ve birleşen sonuç verify edilir.
GPU/toolkit ve kapasite teşhisi bu dilimde yeniden ölçülmedi. Legacy read-only, çalıştırılmaz.

Fable host guard .agents/refactor/host-guard.mjs/test.mjs önceki checkpoint'tedir; hook bağlama
.claude/settings.local.json içinde yerel ve gitignored'dır, ürün yetkisi değildir. Codex/Cursor host
hook bağlama ve plugin eval açıktır. Geliştirme kanıtı /home/alperen/deckent-refactor-work altında,
Git/npm dışında tutulur; eski communication.md kanalı kullanılmaz.
