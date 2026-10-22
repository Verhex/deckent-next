# Deckent Next — ana plan

Bu dosya devam eden işi üç katmanda taşır: **Şimdi** (en çok yedi beta grubu), **Sıradaki** (owner kararlarıyla sıralı iş) ve **Gelen kutusu** (haftalık triyaj; bulgu otomatik iş değildir). Yalnız güvenlik veya canlıyı bozan bulgu kuyruğu atlar. Beta öncesi yeni yüzeyi owner açar; Y1 ve ONAY-GUVENCE D0–D3 bu kapsamdadır. Katmanlar core (Deckent), enterprise, custom; tek bütün ürün/tek sürüm, ürünleşmeden yeniden katmanlama yok.

**Owner yönü 2026-10-15:** yeni araştırma konusu yok; verilen hiçbir karar plansız kalmaz. Önce beta kapısı işleri → owner denemesi → beta.1 (2026-10-18: kalan kod alpha.46 tek paketinde, sonrası yalnız kanıt). Beta ağırlıkla dogfood; npm beta geçişinde `beta`, kararlıda `latest`. Masaüstü ve ajan organizasyonu geliştirmesi beta sonrasında; ilk statik tıklanabilir tasarımlar önce hazırlanabilir. **Genel tanıtım hızlı ve güçlü, owner'ın kabul ettiği masaüstünü bekler.**

Ayrıntılı sıra, dilimler, bağımlılıklar ve açık sorular [2026-10-15 yol haritasında](.deckent/docs/plan/roadmap-2026-10-15.md). Önceki PLAN metni bağlantıları taşınan konuma uyarlanarak [arşivde](.deckent/docs/plan/archive-2026-10-14.md); tamamlanan iş [COMPLETED-PLAN](COMPLETED-PLAN.md), karar [owner-decisions](.deckent/docs/decisions/owner-decisions.md), sözleşme [ARCHITECTURE](ARCHITECTURE.md). Kimde-ne-var host panosunda; karar→plan eşlemesi ve kaynak snapshot'ı dış `proof/PLAN-UZLASMA-2026-10-15/` içindedir. Bu belge uygulama veya yeni yürütme izni değildir.

**Son saklanan sürüm kaydı:** alpha.38 `7eba8b1f`, 2026-10-14 17:03Z canlı/N1 sağlık kaydı; PR #87 ve main hosted CI yeşil, alpha.37 tek seferlik istisnası bitmiş. İlk canlı `/do` ve ilk teslim/benimseme 10-13 kayıtlarında. Bu belge çalışmasında canlı/N1 yeniden doğrulanmadı. Günlük paket: exact aday Astra PASS + hosted CI yeşil → owner'ın tek sürüm kararı; insan gerektiren adım owner'da, yazar kontrolü bağımsız PASS değil.

**Beta kapısı (sekiz koşul; beta kabulü verilmedi; durum 2026-10-21):** (1) owner terminal kabulü: owner denemesi bekleniyor; (2) dispatch öncesi S6: kod alpha.39/alpha.46, kabul kanıtı açık (BETA-RAKIP-4); (3) NATIVE-BAGLAM: kod alpha.39, kabul kanıtı açık (BETA-RAKIP-4); (4) temiz makine provası: açık, N1 50 görev son sayım 20/50 (2026-10-18); (5) exact aday CI: alpha.50 kendi head'inde yeşil, beta adayı Node 26 (10-28) sonrası yeniden; (6) dürüst bilinen sınırlar/README: sürekli; (7) N1 devir ve test-ERP canlı gözlemi: açık; (8) CLI-INSAN (owner 2026-10-19; Sıradaki 14): kod alpha.48'de, kabul açık. 5'in alpha.38 tarihsel yeşili gelecekteki adaya taşınmaz; 7 fixture kanıtıyla kapanmaz. Aşağıdaki gruplar bu kapıların açılmış ön işlerini içerir.

## Şimdi (en çok 7)

**İndi (kayıt, iş değil):** alpha.39 kapı kodlarını çıkardı: S6 sır kapısı, NATIVE-BAGLAM, MCP AI aktörü + taban, denetim kontrol noktaları, /runs tuşları (Y1), ilk registry, ücret ekseni. alpha.43 teslim kuyruğunu, alpha.44 defter v58 + crash-loop breaker'ı, alpha.45 sistem-kıskaçlı plan tavanını getirdi (PR #99 main'de). alpha.46 beta adayı paketi (plan izinlerini sistem türetir; S6 bağımlılık sınıfı); alpha.47 çalışma zamanı R1–R6, beta öncesi son kod paketi; alpha.48 CLI-İNSAN, rehberli kurulum ve güvenlik; alpha.49 solo profil ve küçük düzeltmeler; alpha.50 (2026-10-21, canlı 08:47Z) beta öncesi PRE-1…7 ve PB-COLDSTART faz A; alpha.51 (2026-10-21, canlı 22:02Z) PRE-8/9/10 ve gelen kutusu artıklarını getirdi. Bunların kabulü aşağıdaki kanıt satırlarındadır; kod inmesi kabul değildir.

| İş grubu | Neden / beta bağı | Durum | Sıradaki adım |
|---|---|---|---|
| Owner tam Deckent kullanımı (alpha.51 sonrası) | Kapı 1 ve dış proje kanıtı; owner komple Deckent ile çalışmaya geçiyor | alpha.51 canlı (2026-10-21 22:02Z); proje-wsl alpha.51'de; N1 dalga 8 ve 9 (10 iş, Deckent tek başına) benimsendi; toplu 2026-10-22 ile main'e | Owner test kontrol listesi; proje-wsl gözlemi; beta-süreci kararları |
| Node 26 geçişi + beta adayı | Kapı 5; LTS 2026-10-28 sonrası tam doğrulama ve Astra + hosted CI | Planlandı (2026-10-28) | Node 26'da tam doğrulama → exact aday → owner'ın sekiz koşul kararı |
| N1 50 görev + temiz kurulum provası | Kapı 4; lead yardımı/elle JSON olmadan init→/do→teslim | Açık; son sayım 2026-10-18: 20/50 Deckent tek başına | N1'de 50 gerçek görev; temiz WSL/Docker tam yolculuk + geri alma |
| Owner terminal denemesi (Windows Terminal fare kopyalama dahil) | Kapı 1; /runs tuşları, /deliver, kuyruk benimseme, TERM-KOPYA-2 | Owner denemesini bekliyor | Hedefli kanıt → owner denemesi; Windows Terminal'de gerçek kopya testi |
| Test-ERP / N1 devir canlı gözlemi | Kapı 7; fixture gerçek iş kabulü değil | Açık; canlı gözlem | Gerçek devir gözlemi ve sonuç kaydı |
| K1–K8 komut sadeleştirme (beta işi, paralel) | Betayla birlikte açılan komut birleştirme | Ayrı dalda başladı; betaya kadar canlı değil | Dal ilerler; canlıya yalnız beta kararından sonra |
| Betaya taşındı (owner 2026-10-18, 2026-10-22) | Beta öncesi kod paketinde değil | SIWC (ChatGPT ile giriş) görünürlüğü, Y3 onay kanalı, Y4 taban, D3 uzak karar tasarımı, OTONOM-TESLIM D0–D4 + teslim kartı insan özeti | Beta sürecinde; bilinen sınırlarda "beta sürecinde" yazılıdır |

Yeni sabit lane/worker sayısı yok. Ayrıntılar [beta öncesi](.deckent/docs/plan/roadmap-2026-10-15.md#beta-oncesi) ve [güvence](.deckent/docs/plan/roadmap-2026-10-15.md#guvence) bölümlerinde.

## Sıradaki (karar verildi; sıralı)

1. **Beta.1 → dogfood ağırlıklı beta:** sekiz koşul ve owner kabulü; yayımlama tarihi uydurulmaz. alpha.46 = beta adayı (owner 2026-10-18); sonrası yalnız kanıt. beta.1, 2026-10-28 Node 26 geçişini bekler; kontroller Node 26'da tekrarlanır (owner 2026-10-20). Canlı+N1: alpha.51 (2026-10-21).
    - **Beta öncesi kod (owner 2026-10-20 atama):** PRE-1…PRE-7 alpha.50'de indi (CHANGELOG alpha.50 satırı; ayrıntı [atama](.deckent/docs/plan/roadmap-2026-10-15.md#beta-oncesi-2026-10-20)); PB-COLDSTART faz A alpha.50'de, faz B/B1/B2 beta sonrası owner kararı. LINT-ARCH-DYNAMIC N1 w8c ile kapandı (sabit metinli dinamik `import()` kenarları birim grafına ve döngü kontrolüne girer; değişkenli belirteç çözülmez; toplu 2026-10-22, canlıya sonraki sürümle). Açık kalan: PRE-7 kanun denetimi koşulları `proof/PRE-BETA-2026-10-21/PRE-7-BRIEF.md`.
    - **Beta öncesi kod:** PRE-8, PRE-9, PRE-10 alpha.51'de indi (released 2026-10-21; ayrıntı Sıradaki 18).
2. **BETA GEÇİŞİ = NPM + DOKÜMAN + SİTE (owner 2026-10-22):** beta geçişinde npm paketi yayımlanır: büyük olasılıkla scope'lu `@verhex/deckent` (`npm install -g @verhex/deckent`; komut adı `deckent` kalır). Scope'suz `deckent` `dedent` benzerliğine takılıyor; @'siz `Verhex/deckent` GitHub kısayoludur. Yayın `beta`, kararlıda `latest`; ad yayından önce kesinleşir, docs/site komutu ondan sonra yazılır; tüm dokümantasyon güncellenir: kurulumu yapan AI ya da insan neye ihtiyacı olduğunu ve neler yapabileceğini bilir; deckent.ai sitesi ve docs sayfası açılır. Betaya geçince bir süre bu işler; ardından beta iş maddeleri yeniden sıralanır, dogfood ile geliştirme ve tam ürünleşme ([karar](.deckent/docs/decisions/owner-decisions.md#paketleme-test-2026-10-22)).
3. **Masaüstü + ajan organizasyonu:** beta sonrası, tanıtım kapısı. §8'deki 17 dilim; ilk karne/havuz/olay akışı, desktop 4'ten itibaren bağımlılıkla; altı owner sorusu **açık**. **POST-BETA-PRODUCTIZATION-COMPARISON** (owner 2026-10-15): Paperclip/Hermes karşılaştırmasıyla Desktop yönetimi, hızlı onboarding, entegrasyon ömrü, çıktı inceleme ve insan yükü A0–A7 aşamaları; ilk adım güncel kaynak/boşluk matrisi → AL/UYARLA/ALMA → kabul kanıtlı dilimler ([brief](.deckent/docs/plan/post-beta-productization-paperclip-hermes.md)).
4. **ATAMA + HEADLESS-BRAIN:** sistem WorkClass→model/effort atar, Brain frontier; agent/skill tier, başarı defteri. Headless abonelik Brain **zorunlu**; N2-0, tier, kimlik ve H5 ölçüm tavanı bağımlılıkları.
5. **TEST-AZALTMA + OTONOM-TESLIM:** ölçüm→ortak fixture→gölge makbuz/seçim; güvenlik/negatifler korunur. **OTONOM-TESLIM beta içinde** (owner 2026-10-22, [karar](.deckent/docs/decisions/owner-decisions.md#otonom-teslim-beta-2026-10-22)); teslim kartı insan özeti onunla aynı iş. Kural açılana kadar teslim y/N, adopt/rollback hep y/N; gölge süresi ve dar kuralın kapsamı beta-süreci kararlarında.
6. **Eşzamanlılık:** 1–2 ölçüm/kayıt, S6 (kapı kodu alpha.39'da indi; bağımlılık sınıfı alpha.46'da); ardından 4→{5,6}→7→8→9→ölçüm gerektirirse 10. Veri maskeleme yöntemi Enterprise tamamlandıktan sonra ayrı süreç.
7. **POLITIKA-MODULU P1–P5 + güvence** (Y3 onay kanalı, Y4 taban, D3 uzak karar tasarımı betaya taşındı, owner 2026-10-18): iki gerçek kişiyle devir, rol/signed bundle/Enterprise merkez; D4 FIDO2, D5 imzalı paket (OG7), OG5 önce host hijyeni ölçümü sonra tam ayrım. Varsayılan zorunlu dokunuş yok; kurtarma+backup anahtar önkoşulu korunur.
8. **ABONELIK-LIMIT L1–L9:** L0=N2-0 ortak ödeme ekseni; kişi/limit/zamanlı başlangıç/kota; API geçişi kart+varsayılan kapalı kişisel tercih+bildirim. L3 kişi yalıtım tasarımı owner'la konuşulur.
9. **KOMUT-BIRLESTIRME + TERMINAL-UX kapanışı:** K1–K8 beta işi olarak ayrı dalda paralel başladı, betaya kadar canlı değil; S0–S8 tek paket; /runs,/compact,/deliver, needs-input, hareket/odak/tuşlar; fiziksel ölçüm sorumluluğu U5'e göre. WORKER-NEEDS-INPUT, S3/S8 ve S12a'nın kullanıcı sonucu ve negatif kabul ayrıntıları **BETA-RAKIP-2**'de (Sıradaki 15); aynı iş, ayrı uygulama açılmaz.
10. **YUZEY-UYUM ve MUSTERI-YOLCULUK kalanı:** S4–S12 bağımlılıkla (G1–G3/Y1 öne alındı); müşteri dilim 3–8. SDK **Y2 yalnız yönetilen yol**, M3 operation list beta sonrası ilk ERP kartı; M4 Core insan beyanı ayrı son durum/kanıt eki, UI sonra.
11. **Claude kimlik yolu:** owner a–d için Hiçbiri dedi, kendi analizini bekler. H4 taşıması aşılmıştır; mevcut yol doğrulanmış ikameyle aynı dilimde değişir, worker kesilmez. Diğer açık/M5/custom/bütçe işleri yol haritasındaki korunmuş kuyrukta.
12. **DOSYA-BOYUT-OLCU (beta, owner 2026-10-18):** satır ölçüsü uzun satırlarla aşılıyor (src'de 200+ karakter 1416 satır). Önce mimari kontrole dosya bayt bütçesi, satır uzunluğu sınırı, fonksiyon uzunluğu ve bağımlılık sayısı ölçüleri mevcut durumda kilitlenir; sonra sırayla bölme: `errors/registry.ts` (95 KB) alan başına, `i18n/*/cli.json` (1493/1500) bölüm başına, `composition/agent-turn/turn.ts` (42 KB) iş mantığı sahip birime; ardından `cli-terminal/terminal.ts`, `monitor/view.ts`, `native-connection/worker.ts`.
13. **HARNESS-FARK (owner 2026-10-18, kaynak proof/HARNESS-GAP-2026-10-18):** alpha.46'ya giren hızlı kazanımlar: kalıcı bağlam göstergesi, taslak saklama, yazı geri alma, geçmiş arama/istem atlama, teslim penceresinde salt okunur fark. **Beta:** görsel/pano eki, uzun istem için harici editör, oturum adlandırma/süzme, terminal dışı bildirim, yanıt stili, sohbet kopyala/dışa aktar, kuyruktaki mesajı düzenleme/yön verme, modelin seçenekli soru sorma aracı (ask-user motor sözleşmesi). **Sonra:** plan modu (`/plan` ayrılmış), oturum çatallama, checkpoint/geri sarma (dış etkiler telafi semantiği ister), hook'lar (yeni güven yüzeyi), sohbet alt ajanları, yapılacaklar listesi, tuş yeniden eşleme/Vim.
14. **CLI-INSAN (owner 2026-10-19; ölçüm kurulu alpha.46, WSL):** CLI hem AI hem insan yüzeyidir; komut adları ve tipli argümanlar AI için aynı kalır (10-18 "uzun adlar korunur" kararı geçerli). Ölçüm: 27 ana komuttan 20'si argümansız yalnız `CLI_USAGE` verir, eksik argümanı söylemez; 5'i çalışır (`monitor`, `models`, `config`, `doctor`, `paths`); `terminal`/`init` etkileşimli terminal ister; scope'ları listeleyen yol yok. Komut başına ayrıntı: [CLI incelemesi](.deckent/docs/plan/cli-review-2026-10-19.md). K1–K8 dalıyla aynı komut ağacında yürür. **Beta kapısı 8:** tamamlanmadan betaya çıkış yok (owner 2026-10-19); alpha.46 kod dondurmasının owner istisnası; owner ana oturuma **alpha.48** paketi olarak iletir (devir özeti incelemenin başında).
    - **Boş komut yok:** yardımda görünen her ana komut tek başına ya güvenli varsayılan eylemini yapar (ör. `workers` → varsayılan scope'ta `list`) ya da alt komut listesini ve eksik argümanın adını gösterir (`claude mcp` tek başına alt komutlarını basar); çıkış kodu 2 korunur.
    - **Ana yardım (`deckent --help`/`-h`):** detaylı, tam ve anlaşılır; 30 satır sınırı kalkar, hedef 100–150 satır (owner 2026-10-19). Komutlar ile seçenekler ayrı bölümlerdir (`claude -h` "Options"/"Commands" gibi): her komut alt komutları ve argüman imzasıyla, her genel seçenek kendi satırında açıklamasıyla. Yüzeyler anlatılır: argümansız `deckent` = etkileşimli terminal, CLI, `deckent-mcp`. `--help --all` ayrımı kalkar; geliştirici komutları ana yardımda kendi başlığıyla görünür. Sınırı bugün `cli-grouped-help.test.ts` (`<= 30`) ve katalog notu taşır; ikisi yeni sınırla birlikte değişir.
    - **Scope ve iç kimlikler (owner 2026-10-19):** `--scope` yoksa yalnız okuma komutları `terminal.scopeId` kullanır ve çıktı başında scope'u yazar. Değişiklik yapan komutlarda TTY'de varsayılanı önceden seçili scope seçicisi + onay; pipe/AI yolunda `--scope` zorunlu, yoksa geçerli scope listesiyle hata. Scope listeleme yolu eklenir. İnsan yolunda `--command-id`, `--expected-revision`, attempt/generation/layout sistemce doldurulur, TTY'de run/görev seçici.
    - **Dil ve okunurluk:** komutlar dili config `language`'dan çözer (bugün `report.ts:16` ve benzeri 12 dosya yalnız `--lang`/ortam okur; çeviri var, kullanılmıyor). İngilizce kalan hatalar (`run`, `task`, `policy`, `backup`, `init`) ile `workers`/`models` çıktısı TR katalogdan; ham bayt/ms insan biçiminde.
    - **Öncelikli (owner 2026-10-19):** `task integration-queue-list` insan modunda ham JSON basar; teslim kuyruğu (`parked` dahil) okunur tabloya döner — beta kapısı 4 yolunda. `backup verify` var olmayan sette "parola yanlış ya da set değiştirilmiş" der (`BACKUP_PASSPHRASE_INVALID`); hata türleri ayrışır.
    - **Yardım = davranış:** kodda olup katalogda olmayan alt komutlar bir kez taranır ve kaydedilir (ör. `pool quota-release`, `policy mcp`); test eşitliği korur. Değişiklik komutlarında bugünkü sessiz varsayılan scope kalkar (ör. `pool.ts:44`; AI yolunda `--scope` zorunlu, owner 2026-10-19).
    - **İnsan modunda ham JSON yok, listeler bekleyen önce (owner 2026-10-19):** `approval` (`approvals.ts:28` her sonucu `JSON.stringify` basar), `mcp list/get`, `policy vocabulary` ve kuyruk listesi okunur tabloya döner; JSON yalnız `--json`. `approval`, `run list`, `decide`, kuyruk listeleri bekleyen önce, sonra yeniden eskiye.
    - **Kabul kanıtı dürüstlüğü (owner 2026-10-19):** `run inspect`, `report` ve `/runs` kabul satırı kanıt türünü söyler (ör. `process-exit@1` → "kabul: çıkış kodu · içerik bağımsız doğrulanmadı"); Kanun 1.
    - **Run bulma (owner 2026-10-19):** `deckent run list` + kısa kimlik (git gibi); `report`, `run inspect`, `task` aynı seçiciyi kullanır.
15. **BETA-RAKIP (owner 2026-10-20):** rakip taramasındaki dört öncelikli sorumluluk ayrıntılarıyla **beta süreci işlerine alındı**: **1** mevcut kurulumdan elle JSON/lead yardımı olmadan ilk kalıcı işe geçiş; **2** işçinin sorusunu aynı terminalden yanıtlama; **3** kesinti/restart ve belirsiz dış etki kanıtı; **4** aynı sürüme bağlı uçtan uca kabul paketi. [İş eşlemesi ve sıra](.deckent/docs/plan/roadmap-2026-10-15.md#beta-rakip), [ayrıntılı kartlar](.deckent/docs/plan/competitor-beta-knowhow-2026-10-20.md#beta-isleri).
    - INSTALLATION/MUSTERI-YOLCULUK, komut S3/S8 + S12a, RESTART-RECOVERY W11 ve mevcut beta kanıt işleriyle birleştirilir. Durum **planlandı**; lead uygulama sahiplerini belirler. Beta öncesi mevcut sekiz kapı ve kod dondurması ayrı kalır; yeni çıkış kapısı eklenmez.
    - Her kart kullanıcı sonucu, yazma sınırı, önkoşul, sorumlu alan, gerçek yüzey/kalıcı kanıt ve negatif senaryolar taşır. Kullanıcı sayısı hariç ilk kalıcı sonuç süresi, insan emeği, kurtarma doğruluğu ve ölçülebilen maliyet izlenir. OAuth/Run bütçesi korunan kuyrukta; Desktop ve M3/M4 beta sonrası sırasındadır.

16. **AGENT-TAKEOVER (owner 2026-10-20; beta, masaüstü tamamlandıktan sonra):** "agentı devral" ile çalışan bir worker'ı/agent'ı her yüzeyden (terminal, CLI, masaüstü, MCP) devralıp müdahale etmek; "agentı devret" ile yeniden otonom Deckent yürütmesine bırakmak. Yetki, kapsam ve denetim kaydı mevcut sözleşmelerle; devir sırasında iş kaybolmaz.
17. **BETA-GOZLEM (owner 2026-10-20; beta süreci; terminal analizi `94e9b6b3`):** BETA-ISCI-BAGLAM (işçi talimatları geliştirici `AGENTS.md`'sinden ayrılır; küçük işte 13k–100k token yükü, Codex `find ..` kaçışı; DECKENT-MD-WORKERS ile birleşir), BETA-SAGLAYICI-GOZLEM (Codex model doğrulaması, tur/token/maliyet; Cursor kısmı — katalog, tur/token, model denetimi — CURSOR-ISCI ile alpha.52'de kodda; canlı kabul C7 açık), BETA-CLI-DO-DEVAM (CLI `deckent do` onaydan sonra kendiliğinden devam eder; terminal `/do` zaten eder); TERM-KOPYA-2 (klavyeyle kopyalama yolu, OSC 52 bayt tavanı, Windows Terminal'de gerçek kopya kontrolü, tur sonu ile sonraki mesaj arasında boşluk; `terminal` birimi 2000/2000, önce kod taşınır).
    - CIKTI-OKUNUR-2 (PRE-5 artığı: TR çıktıda "heartbeat/worker/nesil" sözcükleri, terminal `/runs` penceresinin kendi "Başlıksız iş" başlığı, verify Run'larına oluşturulurken gerçek başlık (engine; kuyruk parmak izi yükseltme denetimiyle), `run inspect` "(epoch ms)" son tarihi ve `report` yardımındaki "ham değerler", policy önizlemesindeki sözlük kimlikleri, `workers --verbose` 64 haneli Run kimliği).
    - ORTAM-HAZIR-2 (PRE-7 artığı): şablona gereksinim ekleyen ayrı komut (değişen şablon yeni içerik kimliğiyle kaydolur, görev türü bağı açıkça taşınır; bugün `config set admission.registry`); doctor'da ortam yüzünden park edilen Run'lar satırı; N1 kodlama şablonlarına gereksinim eklenmesi alpha.50 geçişinden sonra owner onaylı config ile. Beta sonrası Enterprise: ERP denetimleri için değer döndürmeyen gizli referans çözücü.
18. **NATIVE-PLATFORMLAR + PRE-8 PROJE-ANAHTAR + DIS-PROJE (owner 2026-10-21):** tam native Windows ve macOS **beta kapsamında**; beta.1 planlanan tarihte Linux/WSL ile çıkar; betadan çıkış = üç platformda native çalışma. [İş planı taslağı](.deckent/docs/plan/native-platforms-2026-10-21.md): N0 ortak portlar → N1 macOS / N2 Windows → N3 yalıtım → N4 işçiler → N5 kabul; altı owner kararı açık. [Karar](.deckent/docs/decisions/owner-decisions.md#dis-proje-windows-2026-10-21).
    - **PRE-8 (alpha.51'de indi, released 2026-10-21; beta öncesi çekirdek; owner 2026-10-21 modeli, [karar](.deckent/docs/decisions/owner-decisions.md#pre8-secret-model-2026-10-21)):** proje kasası + yalnız referans tutan `.deck` + kullanım anında yönetici izni (solo: ilk kullanımda kart) + "kimde hangi anahtar" CLI listesi; betada `deckent admin` paneli ve son kullanma takibi. Kapsam etiketli ad tasarımı reddedildi.
    - **PRE-9 SOLO-MOD-IZNI (alpha.51'de indi, released):** solo sahibi tam otomatik/tam erişimi terminal onaylı ürün komutuyla açar (bugün şablonda izin ve komut yok). **PRE-10 OTURUM-MODEL-PIN (alpha.51'de indi, released):** "Yalnız bu oturum" model seçimi varsayılansız kurulumda çalışır (`turn.ts:105`). Owner'ın WSL projesi (`proje-wsl`) 2026-10-21 kuruldu (başlatıcı, ayrı global kök, kullanıcı servisi, MCP, monitor kaynağı); Windows projesi `/mnt/c`'de `BOOTSTRAP_STATE_UNSAFE` aldı ve owner kararıyla native Windows'u (N2) bekler.

Bu liste gerçek bağımlılıkla yürür; güvenlik/live kırılması öne geçer, analiz önerisi otomatik admission olmaz. Ayrıntı ve tüm karar kimlikleri [yol haritasında](.deckent/docs/plan/roadmap-2026-10-15.md). Altı ajan-organizasyon sorusu, H5 tavanı, KC ayrıntısı ve Claude kimliği [açık girdilerdir](.deckent/docs/plan/roadmap-2026-10-15.md#acik-sorular).

## Gelen kutusu (haftalık triyaj; iş değil, bulgu)

Kural: bulgu triyajda sıraya ya da arşive gider; yalnız güvenlik/canlıyı bozan bulgu hemen kuyruğu atlar. Tam eski satırlar [arşivde](.deckent/docs/plan/archive-2026-10-14.md) "Gelen kutusu" bölümünde.

- **İlk canlı /do kırılma noktaları (2026-10-13/14, `proof/DO-UCTAN-UCA-N1-2026-10-13/KIRILMA-NOKTALARI.md`):** run-create kartı alanları (risk/geri alma/kural "araç bildirmedi"); reasoning kapalıyken QUERY_UNEXPECTED_FAILURE; bayat checkout koruması; 72 minör tutulan rezervasyonun uzlaştırılması; /do kartı TTL 10 dk; CLI `do` onaydan sonra devam etmiyor. WORKER-NEEDS-INPUT, owner 2026-10-20 ile Sıradaki 9/15'te aynı S3/S8/S12a işine bağlandı; tamamlanmış değil.
- **İlk dış proje kurulumunda (proje-wsl, 2026-10-21, alpha.49) üç kusur:** (1) `/model` "Yalnız bu oturum" seçimi, kalıcı proje/varsayılan model yokken ilk turda `TERMINAL_CHAT_NOT_CONFIGURED` ile düşer: `assertTerminalChatReady` (`src/composition/core/terminal-chat/internal/turn.ts:105`) oturum pinine bakmadan `describeTerminalChat` sonucu reddeder; PTY'de yeniden üretildi, "Bu oturum ve varsayılanım olsun" ile çalışıyor. (2) Yeni solo kurulumda tam otomatik ve tam erişim engelli: ilk kurulum şablonu v13'te `permission-mode`/`set` izni yok ve bunu veren ürün komutu yok (canlıda elle kurulmuş `live-permission-modes` izni var).
    - (3) `secret list` proje profillerinin başvurduğu `DECKENT_ANTHROPIC_KEY` için "başvuru yok" diyor. Host notu: terminal `/service-restart` systemd'nin yönettiği servisin yanında kendi servisini açar; systemd birimi `LOCAL_RUNTIME_ALREADY_RUNNING` döngüsüne girer.
- **`deckent-mcp --help` (2026-10-21, alpha.49):** yardım yerine `MCP_START_FAILED` basıp 0 ile çıkıyor; CLI-INSAN (Sıradaki 14) kapsamına aday.
- **Belge kayması:** DOGFOOD-PARALLEL-DELIVERY açık görünüyordu ama alpha.25'te indi (arşive taşındı).
- **Kod borçları (arşiv satırları):** BATCH-D-KALAN (WSL/Windows kabulü), E2-LAW-DEBT, F-LAW-DEBT, EXT-REGISTRATION-VERSIONING (Kanun 10), REDACT-LONG-ATOM-MARKER, SANDBOX-AUTHORITY-FOLLOWUPS, TERM-TEST-FIXES (B4 kök neden), MCP-REDIRECT, EFFECT-FENCE-PROVENANCE, PACKAGE-SPLIT (beta sonrası), CONFIG-GROWTH, CONFIG-SOURCE-DECISION, HARDCODE-P1, N1-VERIFY-EXCLUSIONS-V13, MONITOR kalanı (push akışı, PATCH_LIMIT sebebi), DELIVERY-GATE-SCOPE, KANUN-8-GUNCELLEME (owner onayı bekler).
- **IPTAL-ETKI-DOGRULUGU (owner 2026-10-21: betada düzeltilecek):** tur iptali onaylanmış ve bitmiş bir araç çağrısını `cancelled` bildirir (`engine/core/agent-turn/internal/loop.ts:421`), iptalle duran yazma kümesi kısmen uygulanmış kalabilir; `tool.finished.status` dış sözleşme alanı olduğu için doğru düzeltme sözleşme değişikliğidir (seçenekler: tamamlanmışlık bayrağı ya da yeni durum + protokol adımı). alpha.51'de bilinen sınırda (kaynak: LIVENESS-EINTR hattı, `proof/ALPHA51-2026-10-21/HANDOFF-LIVENESS.md`).
- **alpha.50 takipleri (2026-10-21):** (a) `doctor` canlı, N1 ve proje-wsl'de alpha.50 başlangıcından sonra "Çalışan servis eski yapılandırmayla çalışıyor" diyor; başlangıçtaki işçi imajı yenilemesi (r22-20261021) yapılandırmayı yazar ve servis onu yeni Run'lara zaten uygular; uyarı yanıltıcı (kaynak: lead, 2026-10-21).
    - (b) Astra 2700 P2: depo çakışmasında düşen probe-hold uzlaşması "kaldırma kanıtlanamadı" diye defterlenir (yanlış neden); testlerde enjekte depo reddi ve bayat kimlik/probe/tür hücreleri yok (kaynak: Astra 2700).
    - (c) gerçek binary: probe sırasında iptal edilen Run için `run inspect` "işçi sonlandırması doğrulanmadı" basıyor, oysa tek denemesi hiç gönderilmedi; iptal çıktısı "gönderilmedi" diyor (kaynak: alpha.50 gerçek binary denemesi).
    - (d) CI zamanlama flake adayı: `tests/contracts/composition/runtime-overlay-parents.test.ts:60` (node 24, 781 ms'de `cancelled`; PR #107 deneme 1, test değişmedi).
    - (e) alpha.50 canlı geçişinden sonra üç eski MCP süreci eski derlemelerle çalışmaya devam etti (iki alpha.49, biri 5 gün eski) — istemciler yeniden başlayana kadar; `known-limits` içinde karşılığı yok.
- **alpha.51 sonrası beta takipleri (2026-10-21):**
    - `/provider` paneli yeni anahtar envanterini (`secret list --all`) kullansın (kaynak: PRE-8 HANDOFF).
    - Token sayma yolunda gönderim öncesi anahtar/izin denetimi (kaynak: PRE-8 HANDOFF).
    - Bir iznin `decisionEventId` kaydını defterden arama (kaynak: PRE-8 HANDOFF).
    - Rehberli `deckent setup` `--modes` önersin (kaynak: PRE-9 HANDOFF).
    - Yedek sır adı üç yerde yazılı; tek kaynağa indirilsin (kaynak: S6FP HANDOFF).
    - Çalıştırma görünümü, kota yüzünden iptal edilen görevi "başlamadan önlendi" diye etiketlesin (kaynak: PRE7FU HANDOFF).
    - DOGFOOD-50-PORT: 41 benimseme main'e, alpha.51'den sonra ayrı PR (owner 2026-10-21).
    - `n1-switch.sh` N1 teslim klonunu eşitlesin (RUNBOOK §6b; kaynak: alpha.51 geçiş notu).
    - Dalga 8 yeniden koşusu alpha.51'den sonra (kaynak: alpha.50 takipleri). Tur iptali etkisi için bkz. IPTAL-ETKI-DOGRULUGU.
    - known-limits `runtime restart` satırında 'environment never read' yerine 'target service process environment is not read' ifadesi tercih edilsin (Astra 2714, engelleyici değil).
    - `secret handover` yalnız terminal tanığıyla korunuyor; mühürlü `secret-handover` kararı (politika hücresi + audit) beta adayı (Astra 2702 açık sorusu; HANDOFF-PRE8 REVISE 2702).
    - TESLIM-KARTI-OZET (owner 2026-10-22, OTONOM-TESLIM ile betada): teslim/benimseme kartı bilet kimliği ve dosya yolu gösteriyor; insan karar veremiyor. Her iş için tek satır sonuç (ne çözdü), kabul kanıtı ve risk sınıfı; ERP onayında da aynı kart.
    - MONITOR-ETKILESIM (owner 2026-10-22, beta monitor düzenlemesine girdi): `deckent monitor` gelen kutusu ve onaylar etkileşimli değil; owner N1 w8a işçi sorusunu monitorden cevaplayamadı ve işçinin içine giremedi (cevap yalnız terminal/CLI `run resume`; işçiye girme = Sıradaki 16 AGENT-TAKEOVER).
- **CURSOR-ISCI sonrası (2026-10-22, alpha.52):** PRE-3'ün Cursor kısmı (deneme "devam ediyor"da takılmaz) ve BETA-SAGLAYICI-GOZLEM'in Cursor kısmı CURSOR-ISCI ile alpha.52'de kodda ve testte; kapanış canlı kabule bağlı: C7 = N1'de konteynerde gerçek bir Cursor kartı uçtan uca (tur/token/model sonucu/rapor/benimseme), katalog kaydı geçiş kalıcı olduktan sonra.
    - Cursor yeniden adlandırması → tutulan denemeler: erken tespit (araç zinciri yeniden ölçümü ya da monitor ipucu); aksi halde güncellemeden sonra o modeldeki her Cursor denemesi `unverified` tutulur (known-limits).
    - Araç zinciri otomatik güncellemesi taban imajdaki Node güvenlik sürümlerini izlemiyor.
    - proje-wsl monitor "başlamadan önce yapılandırma değişti" ile kendi `describe` güncel çıktısı çelişiyor.
- **Açık P1/P0 listesi:** aşağıda.

## Alan kimlikleri (arch.json `plan` bağları)

| ID | Kalıcı kapsam / kapanış beklentisi |
|---|---|
| FOUNDATION | Paket/katman/import, config, i18n, dosya düzeni ve boyut kapıları; yeni yüzeylere aynı kurallar. |
| CONTRACT | Ontoloji, sürümlü komut/sorgu/olay, görev grafiği ve tek geçiş sahibi; tüm yüzeylerde aynı anlam. |
| STORE | Transactional ledger, kapsam, migration/restore; DB adapter başına gerçek tutarlılık kanıtı. |
| SECURITY | Principal/policy/approval, secrets ve audit; Core güvenli, Enterprise kimlik/organizasyon eklentileri ayrı. |
| ISOLATION | Workspace ile sandbox ayrımı; worker yetkileri, kaynak çatışması ve canlı hedefe güvenli teslim. |
| EXECUTION | Kalıcı DAG/koşul/parallel join, runtime/recovery, kabulden sonra bağımlılığın açılması; belirsiz etkide kör tekrar yok. |
| PROVIDERS | Çoklu native model, kapasite, ücretli API bütçesi ve abonelik gerçek/simülasyon ayrımı; sessiz sağlayıcı ikamesi yok. |
| SURFACES | Ortak SDK/CLI/MCP; MCP client/server ve sonraki UI/API yüzeylerinde tipli sözleşme ve erişilebilirlik. |
| INSTALLATION | Basit kurulum, sürümlü profil/policy, paket/imaj doğrulaması, kurtarılabilir kurulum ve dağıtım. |
| IFS-E2E | Cloud ve Applications 10'da aynı iş operasyonunun scope/policy/approval/etki uzlaştırmasıyla kanıtı. |
| LANG | TS referansına karşı seçilmiş Go supervisor deneyi; toplam bakım/dağıtım/güvenilirlik kazancı olmadan geçiş yok. |
| DOGFOOD | Kararlı N ile izole N+1 geliştirme; kabul/kurtarma kanıtı, maliyet izlemi ve dış kurtarma yolu. |
| MEMORY | Kapsamlı kalıcı kayıt, revision/provenance, conflict journal, yetkili retrieval; sessiz silme yok, indeks kayıt otoritesinin yerine geçmez. |
| LEARNING | Doğrulanmış sonuç→routing/skill/model iyileştirmesi; bağımsız eval, provenance, geri dönüş. CORE-MODEL R1/R2 analizi ve kalan hukuk/consent kapıları [workstreams](.deckent/docs/plan/workstreams.md). |
| ASSURANCE | Yük/arıza/platform matrisi, backup/restore, sürüm yükseltme ve Core/Enterprise ayrı yayın kanıtı. |
| AOF-HANDOFF | Tipli devir + accepted-attempt Run notları; main'de ve canlıda (arşiv). |
| AOF-DECISION-PORT | Karar portu (ledger v46); main'de ve canlıda. |
| CONFIG-SURFACE | Registry config yüzeyi; main'de ve canlıda. |
| HARDCODE-P1 | Sabit-kod ratchet borcu (19 grup); Gelen kutusu. |
| KAYNAK-KALITE | Worker kaynak/maliyet/kalite: bounded yerel iz, CPU/RAM inspect/monitor, Run maliyet/kabul raporu, saf öneri motoru; yol haritası Ölçüm/Eşzamanlılık işine bağlı. |
| SECRET-REDACTOR (B7) | Gizli bilgi redaksiyonu; B7 + S06 + SAFE-APPROVAL-A1 indi, REDACT-LONG-ATOM-MARKER Gelen kutusunda. |
| M5-D5 Brain ve Auditor | `/do` → RunProposal, Mission turları, A-1 LLM'siz assurance_ev; Brain/Auditor devamı (yol haritası M5/Headless); tam eski satır arşivde. |
| MONITOR | İnsan okur canlı izleme yüzeyi (v1+v1.1 indi); kalan Gelen kutusunda. |

## Açık P0/P1 bulgular

Eski tam metinler arşivde ("Eski Açık P0/P1 bulgular").

- **P0:** belgelenmiş açık P0 yok (2026-10-10: sağlayıcı denetimi 0 P0; Astra 2493 yeni P0/P1 yok).
- **P1 RESTART-RECOVERY (W11):** bağımsız inceleme, entegrasyon ve gerçek container öldürme + servis restart kabulü yok; kayıp worker `unknown` hold'u MARK-LOST-ATOMIC kararına bağlı. Beta kullanıcı yolculuğundaki kesinti/çift etki/karar kaybı kabul ayrıntıları **BETA-RAKIP-3**'e bağlıdır (Sıradaki 15); açık bulgu kapanmış sayılmaz.
- **Sağlayıcı denetimi P1'leri** (W6, `1c602d94`, 0 P0 / 10 P1 / 14 P2): çoğu alpha.23'te indi; kalanlar (A04/A05 Z.ai parser, A08 thinking-off seçimi, MODEL-STATE-PARITY/BUDGET-HOLD parçaları) arşivdeki metinden izlenir.
- **SANDBOX-HOME-WALK:** bağımsız inceleme ve birleşik/hosted kabul açıktı; alpha.26+ içinde indi, kapanış doğrulaması arşiv metninde.
- **OPENROUTER-GATE (owner ön koşulu):** ilk ücretli OpenRouter çağrısından önce "Prevent overrides" eklentisi yok ve OpenRouter kredi limiti Deckent bütçesinden yüksek değil.
- **MODEL-INGRESS-P3:** native worker'ın kendi araçları Deckent giriş yolunun dışında.
- **Dalga 2 takipleri:** patch-prepare reddi tipli makbuz, `LayoutError` insan metni, MARK-LOST-ATOMIC (KARAR 12).
- Etiketsiz açıklar (SBOM gömülü kopya, SURROGATE-CUT sınırları, terminal/provider): [open-findings](.deckent/docs/plan/open-findings.md).

## Owner karar indeksi

Tam metinler [owner-decisions](.deckent/docs/decisions/owner-decisions.md) ve ARCHITECTURE [karar günlüğü](.deckent/docs/architecture/decisions.md)'ndedir.

- 2026-09-21 geliştirme dogfooding sırası, worker izin modu, onay, süre dolması → owner-decisions "Owner kararı — 2026-09-21".
- 2026-09-23 iki hat ve Enterprise katmanı (Core Apache-2.0; ERP adaptörleri registry ile) → owner-decisions + core-memory kanun 10.
- Kalıcı yön (müşteri-kurulumlu ürün, Task/Run/Mission, tek durum sahibi, TS Core) → owner-decisions "Kalıcı yön ve kararlar".
- 2026-09-22 modül yapısı kararı ve bitiş tahmini; legacy → Next envanteri → owner-decisions.
- 2026-09-24 terminal = Claude Code sınıfı ajan terminali; vLLM ayrı iş → [workstreams](.deckent/docs/plan/workstreams.md).
- 2026-09-27/28 terminal döngüsü, POLICY-ADMIN, eşzamanlılık slotu, M1 Hat B tasarımı → owner-decisions.
- 2026-09-29 izin modları, bağımlılık/platform (Node 24+26, zod 4, Apache-2.0) → owner-decisions.
- 2026-09-30 dogfood K1–K9, terminal/model-imaj güncelliği → owner-decisions.
- 2026-10-01 D1–D10 ve dalga 1–5 kararları → owner-decisions, [work-list](.deckent/docs/plan/work-list.md).
- 2026-10-02 MCP-NO-DECIDE, CONFIG-SURFACE, monitör görevi → [status notları](.deckent/docs/plan/status-2026-10-05.md), ARCHITECTURE.
- 2026-10-03 dalga 6 (WorkClass, kendi computer-use mekanizması, Slack+Discord), süreç panosu → [work-list](.deckent/docs/plan/work-list.md) (DALGA-6), core-memory.
- 2026-10-05 kimlik profilleri K1–K3 = A; Qwen host pilotu; NATIVE-AGENTS/MODEL-PROVIDERS/SIWC/CLAUDE-API-KEY-TERMINAL/COMPUTER-USE hedefleri → bu tablo, [qwen-host-pilot](.deckent/docs/plan/qwen-host-pilot.md).

- 2026-10-06 Qwen karar araştırması owner tarafından iptal edildi; native Qwen korunur, karar danışmanlığı mevcut Jev ile sürer. Kapanış: [COMPLETED-PLAN](COMPLETED-PLAN.md), dış proof `QWEN-CANCELED-2026-10-06/`.

- 2026-10-06 Jev host kullanım önerileri kabul edildi; soru tanılaması/yönerge, zaman sıralı follow-up raporu ve 20 farklı kaynaklı pilot uygulandı. Context genellemesi için kazanç kanıtlanmadı; kapanış ve sınırlar [COMPLETED-PLAN](COMPLETED-PLAN.md), dış `proof/JEV-HOST-HYGIENE-2026-10-06/REPORT.md`.

- 2026-10-07 günlük toplu düzeltme PR'ı (dalga = tek PR; main'i kıran düzeltme tek başına), yan/kontrol notları owner'a Türkçe, BACKUP-COMMAND, authority.key parolayla şifreli, satır modu yazma birimi = tamamlanmış satır, vLLM `cache_salt` = HMAC(kurulum sırrı, scopeId) → owner-decisions "Owner kararları — 2026-10-07".

- 2026-10-08 harcama kesinleştirme, fiyat, OpenRouter/LLMTR/DECKENT-MD, sağlayıcı sınırları, beta 2026-10-11 → owner-decisions "Owner kararları — 2026-10-08 (harcama kesinleştirme, fiyat, sağlayıcılar, beta)", ilgili PLAN satırları.

- 2026-10-09/10 DOGFOOD onayı (10-09) ve DOGFOOD ON (10-10 01:17Z, ilk benimseme `8208517a`); DESKTOP-ARCH D1 = Electron + React (10-09); paket bütçeleri geçici composition 7200 / adapters 28000, bölünme beta sonrası (owner 2026-10-11; önceki 6700/26300 sınırı 10-09, 10-10'da batch E bu sınırda bölündü); Jev eşikleri 0,85/0,67 (Teslim düzeni); lead tek yetkili (10-10, geri alınana kadar); `follow-up-works/current-flow.md` kısa süreli görev hafızası, biten iş silinir (10-10) → [karar günlüğü](.deckent/docs/architecture/decisions.md), internal contract.

- 2026-10-06 CI-LOCAL: `ci:local` ubuntu eşleniği, `precommit:fast`, `hooks:install`; CI-SPEED owner onayıyla `land:check` exact-SHA hosted Ubuntu24/26 sonucunu okur; eski yerel makbuz yolu `land:check:local` isteğe bağlıdır; pre-push yalnız `DECKENT_LANDING=1`; macOS/Windows kapsam dışı. Ayrıntı: ci-and-verification modül notu, dış `proof/CI-LOCAL-2026-10-06/`.

- API worker bütçesi tasarımı (owner 2026-10-12): Run başına yürütme boyunca toplam harcama sınırı, rezervasyona Run/Attempt kaynağı, owner'a tasarım olarak gelecek.
- Kaynak ölçümü yük pilotu (alpha.31 sonrası): toplayıcı açık/kapalı yük karşılaştırması, gerçek Docker CPU/RAM kabulü, iz deposunun sınırlı segmentlerle ekleme yapısı yapıldı (yazar adayı; yük pilotu açık); ardından geçici sınırlar ölçümle sabitlenir (K-F S8). Karşılaştırma pilotu: yalnız N1 dogfood, abonelik ve yerel modeller (owner 2026-10-12).
- Görev düzeltme/yeniden deneme yapısı (owner 2026-10-12): başarısız (hata olmayan) görevde agent'ın görevi doğru tamamlaması ve bağımlılık zincirinin sarsılmaması için düzelt-yeniden dene yapısı ileride yeniden gündeme gelecek (deckent-dev'de en çok 3 tekrar vardı; bugünkü karar: otomatik tekrar yok, owner AUTORETRY operator_only_default 2026-10-01). Tasarım owner'a sunulacak; şimdilik uygulanmaz.


2026-10-11–15 karar eki [owner-decisions](.deckent/docs/decisions/owner-decisions.md) içindedir. A1–A8/H1–H6/K1–K8/O1–O6/T3–T4/S1–S8, U1–U5/B1–B3/L-A–L-E, Y1–Y4/M3–M4/OG1–OG7 ve beta/tanıtım yönü [yol haritasına](.deckent/docs/plan/roadmap-2026-10-15.md) bağlandı. Eski metnin sonradan aşılmış cümleleri tarihsel kaynak olarak okunur.

- 2026-10-20 **BETA-RAKIP:** owner rakip taramasındaki öncelikli dört işi ayrıntılarıyla beta maddelerine ekletti; [karar kaydı](.deckent/docs/decisions/owner-decisions.md#beta-rakip-2026-10-20), Sıradaki 15 ve yol haritasındaki beta-rakip bölümü. Ürün uygulaması veya beta kabulü kaydı değildir.
- 2026-10-21 alpha.50 merge, canlı geçiş öncesi gerçek binary denemesi, iş planı → [owner-decisions](.deckent/docs/decisions/owner-decisions.md#alpha50-release-2026-10-21).
- 2026-10-21/22 alpha.51 merge, canlı geçiş, sonraki plan, Docker temizliği → [owner-decisions](.deckent/docs/decisions/owner-decisions.md#alpha51-release-2026-10-21).
