# Anlık iş akışı — native discovery profili

## Son teslim

Baz checkpoint923e5a2 commit/push edilmişti. Owner devam onayıyla ISOLATION/PROVIDERS profil dilimi
uygulandı ve doğrulandı; yeni push bu dilime dahil değil. DOGFOOD_MODE=OFF, Fable kanalı kapalı.

Native authoring invocationv2 CLI sürümünü sabitler; discovery-v1 disabled varsayılanıdır.
Claude abonelikte safe-mode kullanır. Codex/Cursor disabled reddedilir; açık repository istisnası
üçünde de mümkündür. Claude repository modunda yalnız tipli disableAllHooks settings kabul edilir;
key/env/helper/path veya diğer serbest settings alanları ve disabled+settings reddedilir.
Eski hazırlanmış profiller aynı kalır; authoring-v1 sessizce yükseltilmek yerine reddedilir.
Worker sürüm/bayrak kontrolünü credential dosyası ve native görev başlamadan önce yapar.
Uyumsuzlukta preflight78; sessiz API/ücret/kimlik geçişi yok. Aynı policy/reservation/dispatch,
worktree, Docker ağ geçidi, kaynak sınırları ve iptal/kurtarma otoritesi korunur.

Gerçek sıralı koşum: Codex/Claude/Cursor ve Claude settings dosyayı doğru değiştirdi. Settings hook'u
kapattı, MCP yine başladı; bu tam keşif kapatma değildir. Yanlış sürüm ve eksik bayrak iki negatif
koşumda dosyaya dokunmadan durdu. Host auth dosyaları ve kaynak HEAD/index/WIP korundu;
altı worker'ın temizlendiği ayrıca Docker envanterinden doğrulandı. Keşif kapatma otomatik yüklemeyi
sınırlar; worker'ın workspace içindeki dosyaları araçla okumasını yasakladığı iddia edilmez.

Tam verify: **1547 ürün/265 dosya,25 native,44 host; fail/skip0**, lint/build/smoke geçti.
İlk tam koşuda README'ye eşzamanlı açıklama eklenmesi paket değişim korumasını tetikledi
(1546pass/1fail). Kaynaklar sabitlenerek tam koşu tekrarlandı; kontrol gevşetilmedi.
Kanıt: /home/alperen/deckent-refactor-work/proof/NATIVE-DISCOVERY-PROFILE-2026-09-22/
(review.md, verification.json, profile-live.json, cleanup-check.json, full-verify-rerun.log).
Jev0e01f990: sürümlü fail-closed yol%99; none0/insufficient%1, seçim her ikisinde0/1.
Danışma ve kendi doğrulamamız bağımsız Fable PASS'i veya geniş ürün kabulü değildir.
README/ARCHITECTURE/PLAN/CHANGELOG güncel; AGENTS/CLAUDE52 satır, kalıcı ilkeleri aynı.

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
