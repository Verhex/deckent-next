# Yetki sınırı ve karar disiplini

Değişiklik öncesi ilgili Next mimarisi (`ARCHITECTURE.md`) ve legacy ADR kanıtı okunur. Kabul edilmiş kararlar sessizce ihlal edilmez; yeni çelişkide neden, seçenek ve etkileriyle amendment sunulur. Canlı owner talimatı üstündür.

- Onay approved-DAG sınırındadır: yeni scope, authority, destructive veya dış etki owner checkpoint ister. Mevcut izin tekrar sorulmaz; onaysız atlama yasaktır (amend. 2026-08-17).
- Yalnız owner-admitted outcome `PLAN.md` kapsamında ilerler. Bulgu otomatik iş veya kapsam genişletmesi değildir (amend. 2026-08-17): mevcut işi engelleyen bulgu çözülür, diğeri etkisiyle raporlanır. Legacy MASTER Next işi başlatmaz.
- Otonomi ürün hedefidir; hostta izinsiz sprint, worker veya subagent başlatma yetkisi değildir. Gözlem config veya yetki sınırını otomatik genişletmez.
- Yetki devri açık olmalıdır: fallback hedefi güncel config, erişim ve kanıttan seçilir; sessiz model veya sahip ikamesi yoktur. Doküman okumak ya da summary almak yürütme yetkisi devretmez. Gerçek devrin sahibi, sürümü, kanıtı ve kalan etkileri açıktır; mevcut policy ve owner sınırı korunur.
- Legacy runtime/recall komutu çalıştırılmaz; kaynaklar salt okunur incelenir. Legacy package A/B, makine isimleri ve eski branch kuralları Next yetkisi değildir.

Legacy ders: PREPARED → VERIFIED → COMMITTED devir zinciri ve owner recovery ayrımı tasarım dersidir; Next'te varmış gibi ilan edilmez.

Owner 2026-10-02: `deckent-authority-bootstrap` Next'te salt okunur yetki/bağlam kontrolü olarak ayrı kalır; ortak çalışma yöntemi `deckent-next-refactor` içindedir. İlgili yetki, kapsam, revision, sahiplik veya runtime/config değiştiğinde etkilenen kanıt yenilenir; değişmeyen okumalar tekrar edilmez. Runtime yalnız görev gerektiriyorsa incelenir. Rapor HOLD'u yalnız bağımlı işlemin çözülemeyen yetki/kanıt sorusunu gösterir; ürün durumu değiştirmez, ilgisiz yetkili işi durdurmaz ve yeni yürütme yetkisi vermez.

Owner amendment 2026-10-02 — MCP-NO-DECIDE: MCP onay kararını ne `allow` ne `deny` olarak verebilir; `decide_approval` sunulmaz. Listeleme/inceleme gözlemdir. CLI `approval decide`, SDK ve terminal kartının mevcut karar yetkisi korunur; B1'in MCP `deny` istisnası kaldırılmıştır. Ortak runtime/protokol/ledger karar sözleşmesi bu yüzey daraltmasıyla değişmez.

SELF-SOURCE-FLOOR A2 — owner 2026-10-01 narrowing (a/b/c), implemented in the D4 night 2026-10-03: öz-kaynak, projenin gerçek Git ortak dizininin build kimliğindeki kaynak ortak dizinle eşitliğinden türetilir; aynı deponun worktree'si dahildir, ayrı klon/müşteri projesi değildir. Yeni ayar veya ürün varsayılanı yoktur. Full-access değişmez; diğer kiplerde `edit-self-source` modla indirilmez. Statik hard floor öz-kaynak depoda da `edit-floor` kalır; session/standing ile indirilemez. Shell protected names statik zeminde değişmeden kalır; öz-kaynak zemini yalnız yazım sınıflandırmasına eklenir. `edit-self-source` hücresi için yalnız scope+principal+oturum bağlı, mühürlü audit'li oturum cevabı kabul edilir; kalıcı izin `cell-not-standing` ile reddedilir, diğer hücreler değişmez. A1 U2-1'e kalır. Bu karar yeni tel/protokol veya release provenance değişikliği yetkisi vermez.

Owner 2026-10-08 — terminal config seçim sınırı: değerler registry preset/stepper veya gerçek referans kaynağından seçilir; yazılmış TTY `/config` argümanı yetki yolu değildir. Metin girişi yalnız maskeli sır ve açık yeni URL/host istisnasıdır, doğrulama ve önizleme taşır. Kaynak listesi yazma izni vermez: seçilen değer de aynı ConfigApplication policy/onay/digest/audit yolundan geçer. CLI/line-mode script sözleşmesi ayrıdır. Ayrıntı ARCHITECTURE CS-1; yazar kanıtı `proof/SLASH-WINDOWS-2026-10-08/CS1-WORKER.md`, bağımsız kabul değildir.
