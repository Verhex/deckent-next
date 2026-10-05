# İş alanları, açık işler ve kabul edilmiş yönler — PLAN.md'den taşındı (2026-10-05)

Açık işler (2026-09-24), ana iş alanları tablosunun tam metni ve kabul edilmiş yeni yönler. Kısa tablo PLAN.md'dedir.
Kaynak/Source: PLAN.md @58537c7f lines 74–110, 117–140, 216–225; text below is verbatim.

## Açık işler — sıradaki (owner 2026-09-24)

**REPO-STANDARDS — GitHub topluluk dosyaları (owner 2026-10-03):** main'de (`db61005a` README EN/TR + CONTRIBUTING + CODE_OF_CONDUCT + SECURITY + CODEOWNERS + PR/issue şablonları, Codex gpt-6.1-sol uygulayıcı, lead commit; `301a05a0`, `889084e1`; Sol 2290 R1/R2 düzeltmesi `38c9dae1` = `origin/main`). Tamamlanan kısım: COMPLETED-PLAN 2026-10-03. WORKER-GIT-PR de tamamlandı (COMPLETED-PLAN 2026-10-05). Kalan owner'ın GitHub tarafı doğrulaması (private vulnerability reporting, CODEOWNERS erişimi, `main` kuralı — CI-DEBT ve ubuntu-only owner komutu).

### WORKER-GIT-PR — host branch ve PR akışı

Tamamlandı → COMPLETED-PLAN 2026-10-05 (PR #5). Kalan: ayrıca yetkilendirilmiş ilk gerçek worker patch → host branch/PR denemesi; mevcut iniş tek başına canlı GitHub denemesi kanıtı değildir.

**Geliştirme rule incelemesi — owner 2026-10-02:** skill içerik incelemesi ve yetkili düzenlemeler
bu oturumda tamamlandı; kalıcı rol haritası ARCHITECTURE, dosya bazlı karar/kanıt dış alanda
`proof/SKILL-CLEANUP-2026-10-02/remaining-130706Z/`. Kalan rule dosyaları owner ile tek tek değerlendirilir;
sonraki skill delegasyonu bu rule kararlarını otomatik kapsamaz. Üç yeni host oturumunda gerçek
skill etkinleşme/plugin eval kanıtı açık; ortak kaynak ve dosya eşitliği etkinleşme kanıtı değildir.

**CI-DEBT — owner 2026-10-05:** Önceki CI-FIX/current-closure/FLAKY-CI2 uygulamaları tamamlandı → COMPLETED-PLAN 2026-10-05. Kalan hatalar haftaya tek toplu iş; ayrıntı ve koşum kimlikleri `proof/CI-DEBT-2026-10-05.md`. Ubuntu-only ruleset değişikliği owner komutudur; uygulanmış sayılmaz. Native platform/ortam ve gerçek Docker kanıtı yerel testten türetilmez.

**Owner 2026-09-24 akşam — iki ayrı iş (birleştirilmez):** (1) **Deckent native terminal = Claude Code sınıfı ajan terminali:**
Deckent'i geliştirebilecek tam bağlamlı tek model, izin/araç akışı, Deckent takibi, tam otonom iş; 32k bağlamlı yerel model buna
yetmez. Enterprise-grade terminal önceliklendirildi; önce deckent-dev terminalinin kapsamlı analizi. (2) **vLLM yerel paralel worker
altyapısı** (tamamen yerel sistemler için) ayrı iş. ~~GPU owner'a ayrıldı (vLLM durduruldu)~~ — 2026-09-25: GPU izni ve vLLM yeniden oluşturma onaylandı.
**Owner 2026-09-24 gece kararları (terminal):** önce tamamen yerel modelle çalışan terminal, sonra API anahtarlı sağlayıcılar
(native Anthropic dahil); terminalde bütçe/limit yok, sonsuz akış için otomatik bağlam sıkıştırma; kabuk Claude Code gibi kullanıcının
makinesinde izin modlarıyla (izolasyon iddiası değil); Deckent işlevleri/onayları/süreçleri komut, sorgu ve MCP ile; tasarım ve akış
legacy'den taşınır, kanıtlı kusurlar taşınmaz; vLLM worker hattı sonra. Owner'ın canlı kabulü için T-L5 (otomatik sıkıştırma) ve
T-L7 (yerel uzun bağlam profili) önkoşuldur; canlı profil 2026-09-25 owner göçüyle `maxCalls: null` allocation'a geçti.
Analiz ve dilimler (T-L1..L7):
`deckent-refactor-work/TERMINAL-CLAUDE-CODE-CLASS-ANALYSIS-2026-09-24.md`.

**Terminal durumu (2026-09-27):** T-L1–T-L5 (okuma araçları, akış, yönetilen araç döngüsü, kalıcı tur, `chatTurn`, bağlam ölçümü, otomatik sıkıştırma, `/resume` `/new` (bugün `/clear`) `/context`) ve T-L4 dilim 1–3 (araç onayı, dosya yazımı C11 etkisi, `run_shell`, canlı çıktı kuyruğu) ile dilim 4a (izin modları) main'de (`357aeeb`); slash Enter, `@file` ve protokol v15 main'de; dilim 4c, C12 G4 ve kalıcı cleanup işareti dördüncü partide. O tarihte canlı servis eski build'deydi (`b4e77dc`, v14); güncel canlı durum "Canlı kurulum" satırında (2026-09-29: `4a2ac04`, v18). vLLM terminal profili (owner 2026-09-30, seçenek B): `--max-model-len 196608 --max-num-seqs 4 --gpu-memory-utilization 0.92 --speculative-config {"method":"mtp","num_speculative_tokens":2} --prefix-match-unit 16 --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3`; Deckent profili `local-qwen` v6 `contextWindowTokens` 196608; ölçüm: MTP kabul %53–81, sıcak prefix isabeti %96,4, kısa bağlam 144,5 tok/s (önce ~50), betik `deckent-refactor-work/host-tools/inference/start-vllm-terminal.sh`. Açık: ajan döngüsünde bekleme/tekrar (owner oturumu), `/compact` (protokol eki), dilim 4d, 8×32k worker profili. Tarihsel dilim anlatısı [COMPLETED-PLAN](COMPLETED-PLAN.md)'de.

Devam planı: dış çalışma alanı `DEVAM-PLANI-2026-09-24.md` (Astra 2055/2057 değerlendirmesiyle). **S** akış karar listesi
uygulandı ([COMPLETED-PLAN](COMPLETED-PLAN.md)). Sıra: **A-1** yönetilen araç döngüsü tasarımı
(owner onayı 2026-09-24; salt okunur araçlar policy izin verirse ek varsayılan onay olmadan, etkili araçlar mevcut onaylı uygulama
yetkisiyle; `@` dosya adayı scoped okuma portu — uygulandı, protokol v15) ∥ **B09-3** canlı worker satırı + Codex normalizer → **A-2** D15b `do` →
RunProposal → **G31** atama (aşağıdaki satır). Terminal açıkları: kuyruk boşaltmanın duraklatılması (Astra 2057) **K5 tipli havuz bekletmesi olarak uygulandı (20. parti, ledger v44)**,
satır modu akışı, boşta servis durma politikası. Tahminler hipotezdir; effort kayıtlarıyla kalibre edilir.

## Ana iş alanları ve ilerleme yönü

Durumlar tamamlanmış ürün iddiası değildir; aşağıdaki harita çalışan bölüm ile açık kısmı ayırır.
Bağımlılık sırası: FOUNDATION/CONTRACT → STORE/SECURITY/ISOLATION → EXECUTION/PROVIDERS/SURFACES;
IFS-E2E ve DOGFOOD kendi uçtan uca kanıtından sonra, LANG ölçümle; ASSURANCE her aşamada uygulanır.

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
| LEARNING | Doğrulanmış sonuç→routing/skill/model iyileştirmesi; bağımsız eval, provenance ve geri dönüş. **2026-10-04 CORE-MODEL R1/R2 salt-okunur analizi, F1 düzeltme revizyonu:** dış `proof/DECKENT-CORE-MODEL-2026-10-04-R1-R2-F1/analysis.md`; Cursor opt-in ile müşteri rakip model eğitim kısıtı ayrıldı, ayrı inceleme yalnız F1/custody için CORRECTION_VERIFIED (`independent-f1-review/`). Orijinal kanıt değişmedi; genel hukuk/ürün PASS veya veri toplama/eğitim/export/runtime/yeni sözleşme admission yok. Kalan: örnek-tarihli vendor eğitim hakkı, defaultOFF consent/retention/provenance, training-grade payload, ortak model kalibrasyonu ve ölçülmüş kaynak/maliyet. Veri toplamayan Faz1 spec ve local/synthetic eval seçenekleri öneridir; owner kararından önce uygulanmaz. |
| ASSURANCE | Yük/arıza/platform matrisi, backup/restore, sürüm yükseltme ve Core/Enterprise ayrı yayın kanıtı. |

### Kabul edilmiş yeni yönler — kodda henüz tamam değil

- **FOUNDATION — storage adapter seçimi ve katman yerleşimi (owner 2026-09-21, Jev 27f526ee registry_first 0,97):** engine port'ları temiz (domain/engine'de SQLite yok); kalan borç composition'ın SQLite açıcısını doğrudan import etmesi ve `sqlite-*` birim adlarının lehçe taşıması. PATCH-INTEGRATION dilimi indikten sonra küçük dilim: config `storage.driver` → registry'den kayıtlı açıcı + capability manifest (tek kayıt SQLite); üç `sqlite-*` birimi lehçesiz ada geçer, lehçe `internal/` içinde kalır. ARCH-TIERS kartına göre gönderilen adapter'lar `base` katmanına aittir; `core → base` taşıması ve lint'in katman anlamını denetlemesi FOUNDATION'da kod ile birlikte değişir. PostgreSQL bu registry'ye eklenen yeni şerittir, core'a dokunmaz.
- **FOUNDATION — composition paket bütçesi (2026-09-28 owner onaylı artış):** `arch.json` `budgets.packageLines.composition` 5000 → 5500; MCP istemcisi + policy yönetimi wiring'i (yedinci parti birleşmesi sonrası ölçülen 5067 satır); sonraki baskı sorumluluk taşımasıyla karşılanır, yeni artışla değil.
- **Canlı teslim:** başlangıç kanıtı, görevin okuduğu girdiler ve t1 hedef koşulları ayrılacak. Run commit'i tek başına teslim güvenliği değildir. Git koşullu birleştirme/yeniden doğrulama; ERP kayıt sürümü/iş koşuluyla atomik yazma veya açık sınırlı adapter garantisi. Reference-only Git teslimi ve crash reconciliation mevcut; bu, canlı hedefe uygulama değildir. Sessiz ezme/kör tekrar yok.
- **Tool yetkisi:** dosya okuma/yazma/silme, ağ ve iş operasyonu policy'si ortamdan ayrı tanımlanacak; Docker/tmux vb. adapter yalnız gerçekten uyguladığı sınırı sunacak. Shell erişimi varken silme tool'unu gizlemek izolasyon değildir.
- **Maliyet:** ek çağrı ücreti olmayan abonelikte gerçek çağrı maliyeti 0, API eşdeğeri ayrı simülasyon. Simülasyon fiyatı eksikse bilinmiyor; yürütmeyi engellemez. Ücretli API'nin gerçek bütçe denetimi korunur. Provider kapsamı OpenRouter ile sınırlı hedeflenmez.
- **MCP takip kayıtları:** MCP-CLIENT ilk dilimi uygulandı (yedinci parti; yerel stdio, pinli araçlar); MCP-CONNECTIONS/MCP-REMOTE/MCP-VERSION-CAPABILITIES kısmen. Liste: MCP-CLIENT, MCP-CONNECTIONS, MCP-REMOTE, MCP-TOOL-EXECUTION, MCP-EFFECT-RECOVERY, MCP-CAPACITY, MCP-VERSION-CAPABILITIES, MCP-SERVER-CONSISTENCY, MCP-IFS. Ayrıntılı kabul koşulları arşiv raporda korunur; bu liste uygulama başlangıcı değildir.
- **Diğer açıklar:** `provider_limits` O2 uyarınca kaldırıldı; gerçek invocation kotası ve harcama denetimi ayrı korunur; A3A-b belirsiz custody, CANCEL/FAIRNESS, model dışı MCP mutasyonunun işlem öncesi yanıt sınırı; D-CUSTODY’nin kabul edilen dar O5 düzeltmesi uygulandı; periyodik parasal audit/append-only düzeltme, makine okunur maliyet kırılımı, gerçek ücretli çağrı credential ve sayısal tavan kabulü. HOST-JEV-EVIDENCE ayrı WIP, ürün kabulü değil.
