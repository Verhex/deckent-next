# Politika ve AI: kullanıcı ve yönetici kılavuzu

[English](policy-and-ai.md) · [Mimari](architecture-overview.tr.md) · [Uyum raporu](reports/ai-floor-compliance.md)

Kaynak görünümü: 2026-10-15. Politika, doğrulanmış aktörün hangi kapsamda hangi kaynak üzerinde
hangi eylemi yapabileceğini belirler. Grant (yetki kuralı), uygulamanın eylemi değerlendirmesine
izin verir; durum kontrolü, onay, yalıtım, kabul kriteri ve kalıcı etki kanıtını kaldırmaz.
Yönetici yalnız kendisinde bulunan yetkiyi devreder. AI aktör yetki yönetimi yapamaz.

## İnsan ve AI aktörler

| Giriş | Kimlik ve kararın anlamı |
|---|---|
| İnsan terminali / CLI | Doğrulanmış OS kullanıcısı (`os-user`), servisçe doğrulanan etkileşimli kontrol terminaliyle insan kararı verebilir. Yalnız TTY bayrağı yeterli değildir. |
| Etkileşimsiz CLI / SDK | Taşıma adı insan kanıtı değildir. Etkileşimsiz karar açık aktör/eylem hücresi ister. Workload veya token-verified principal AI sayılır. |
| MCP | Daima ayrı AI aktör: issuer `<host>/mcp`, aynı OS subject, workload güvencesi. Eski MCP kimliği `os-user` dese de AI kalır. Owner yetkisi MCP yetkisine dönüşmez. |
| SDK / yerel servis | Aynı doğrulanmış kimlik, politika ve uygulama kapılarını kullanır. İstemcinin yazdığı kimlik, persona veya channel bilgisi yetki vermez. |

Aktör sınıflaması [principal.ts](../src/domain/core/principal/internal/principal.ts) içindedir.
Servis tanıklığı bağlantı eşini, kontrol terminalini ve süreç kimliğini kontrol eder; biyolojik
insan varlığını kanıtlamaz. Owner'ın OS hesabında çalışan ajan PTY üretebilir veya o hesabın
dosyalarına erişebilir. Ayrı OS kimliği, sırların korunması ve gerçek sandbox sınırı önemlidir;
politika hesap yalıtımı değildir.

## Devredilemeyen yetki tabanı

Sürümlü güvenlik tabanı, açık allow ve full-access tercihi dahil sıradan grant'lerden önce
uygulanır. AI sonucu `deny / AI_NON_DELEGABLE` olur. İnsan için de politika yetkisi ve ilgili
tanıklı onay gerekir. Aşağıdaki sınırlar politika kuralı ekleyerek devredilebilir hale gelmez.

Tablo, uyum raporunun bağımsız floor envanterinden üretilir; envanter
[ai-floor.ts](../src/domain/core/policy/internal/ai-floor.ts) kaynağından aktarılmıştır.
Mutasyon ve future-action örnekleri açık uçlu korumaları temsil eder; yalnız yayımlanmış
vocabulary (eylem sözlüğü), uygulanmış açık operasyonları gösterir. Ayar kuralı boş/kök yazımı,
dizi elemanları, alt yolları ve `terminal`, `terminal.shell`, `terminal.fetch` gibi bütün nesneyi
değiştiren üst yolları da kapsar; yalnız benzer başlayan adlar eşleşmez.

<!-- ai-floor:start -->
| Devredilemeyen sınır | Kaynaktaki hücreler | Neden |
|---|---|---|
| Politika yönetimi execute/compensate | `operation/policy.administer/execute`, `operation/policy.administer/compensate` | Grant, rol bağı, devir, kısıtlama, görev ayrılığı ve kalıcı izin AI tarafından yetki genişletmeye dönüşmemeli. |
| Yetki belgeleri, authenticator ve onay güvencesi: tüm değişimler | `authority-document/fixture-record/write`, `authority-document/fixture-record/register`, `authority-document/fixture-record/activate`, `authority-document/fixture-record/remove`, `authority-document/fixture-record/future-mutation`, `authenticator/fixture-record/write`, `authenticator/fixture-record/register`, `authenticator/fixture-record/activate`, `authenticator/fixture-record/remove`, `authenticator/fixture-record/future-mutation`, `approval-assurance/fixture-record/write`, `approval-assurance/fixture-record/register`, `approval-assurance/fixture-record/activate`, `approval-assurance/fixture-record/remove`, `approval-assurance/fixture-record/future-mutation` | Aktör kendisini sınırlayan kimliği veya onay doğrulayıcısını değiştiremez; inspect/list politika kapsamındadır. |
| Yedeği geri yükleme | `backup/fixture-backup/restore` | Geri yükleme yetki verisini değiştirebilir. |
| Yürütme ortamı kurma ve kurulum onarımı | `execution-environment/fixture-target/install`, `installation/fixture-target/repair` | İkisi de sandbox dışında host’u değiştirir (Docker grubu root eşdeğeridir); yalnız terminaldeki kişi çalıştırır (owner 2026-10-19). |
| Full access dahil izin kipi değiştirme | `permission-mode/standart/set`, `permission-mode/full-auto/set`, `permission-mode/full-access/set` | AI kendi izin kipini gevşetemez. |
| Read/resolve dahil bütün sır işlemleri | `secret/FIXTURE_SECRET/set`, `secret/FIXTURE_SECRET/delete`, `secret/FIXTURE_SECRET/switch`, `secret/FIXTURE_SECRET/read`, `secret/FIXTURE_SECRET/resolve`, `secret/FIXTURE_SECRET/inspect`, `secret/FIXTURE_SECRET/list`, `secret/FIXTURE_SECRET/future-action` | Kimlik bilgisini okumak, değiştirmek veya taşımak sır sınırını aşar; read/resolve savunma hücreleridir, açık sır-okuma API’leri değildir. |
| Yetki onay kartları | `approval/identity-profile/decide`, `approval/policy-mcp-capability/decide`, `approval/policy-template-upgrade/decide`, `approval/audit-rebaseline/decide` | Yetki kartını karara bağlamak da yetki değiştiren bir yoldur. |
| Inspect/verify dışındaki audit işlemleri | `audit/fixture-scope/rebaseline`, `audit/fixture-scope/write`, `audit/fixture-scope/delete`, `audit/fixture-scope/future-action` | AI yetki kaymasını saptayan referans kaydını yeniden yazamaz. |
| edit-authority ve edit-floor araç çağrısı hücreleri | `agent-tool-call/edit-authority/invoke`, `agent-tool-call/edit-floor/invoke` | Korunan sınırı düzenlemek operasyon kapısını dolanabilir. |
| Hafıza doğrulama, emekliye ayırma, itiraz ve silme | `memory/fixture-target/verify`, `memory/fixture-target/retire`, `memory/fixture-target/contest`, `memory/fixture-target/purge` | Doğrulanmış hafıza bir kişi ya da bağımsız değerlendirme kaydı ister, AI kendisi asla (kanun denetimi madde 6); emekliye ayırmak da aynı bilgi değişikliğidir; içerik silme (purge) insanındır (S4B A11); doğrulama ve itiraz tabandan yalnız hafıza değerlendirici iş kimliği için geçer (S4B-3 A5); bu hücreler onu adlandırmaz. |
| Nervous durdurma eylemi için kalıcı onay | `recovery-action/fixture-target/apply`, `recovery-action/fixture-target/future-action`, `recovery-action/fence-attempt/apply`, `recovery-action/fence-attempt/future-action`, `recovery-action/stop-orphan/apply`, `recovery-action/stop-orphan/future-action`, `recovery-action/hand-to-human/apply`, `recovery-action/hand-to-human/future-action` | Kurtarma aracısı mühürlü Nervous önerisini yalnız sahibin kalıcı izniyle uygular (K-B, S6R-3); bu izni hiçbir AI taşımaz, Nervous yalnız önerir. |
| Korunan ayar ağaçları, alt yolları ve bütün nesneyi değiştiren üst yolları | `policy`, `approvals`, `identity`, `security`, `storage`, `service`, `paths`, `shell`, `network`, `layout`, `execution`, `installation`, `company`, `enforce_principal_assurance`, `secrets`, `admission`, `operations`, `audit`, `memory`, `memoryAutomation`, `terminal.shell.realm`, `terminal.shell.environment`, `terminal.fetch.egress`, `terminal.fetch.allowedHosts` | Güvenlik, yalıtım, admission, operasyon, audit, shell ortamı ve ağ çıkışı ayarla gevşetilemez. |
<!-- ai-floor:end -->

Kart kararında ayrıca uygulama kapısı vardır: AI/etkileşimsiz çağıran, `edit-floor`,
`edit-authority`, `mcp-floor`, yetki etkili kart, korunan ayar kartı, araç riski bildirilmemiş
kart veya olguları bilinmeyen eski kart için allow veremez. Bu son durumlar
`AI_AUTHORITY_NON_DELEGABLE` ile reddedilir; hepsi basit değerlendirici kaynak hücresi değildir.
Tanıklı insan yolu ve mevcut güvence kontrolleri gerekir. AI korunan çağrıyı oturumluk/kalıcı
izin diye hatırlatarak tabanı aşamaz. Rapor saf politika hücrelerini kapsar; uygulama kartı
korumaları ayrı güvenlik testleriyle sınanır.

## Neler devredilebilir

Bir hücre **principal (issuer + subject) × eylem × kaynak türü/kimliği × kapsam** seçer.
Rol ve rol bağları aynı hücreleri sağlar; istekte rol adı yazmak yetki vermez. Önce ret ve
kısıtlama, sonra `require-approval`, sonra allow uygulanır; grant yoksa ret gelir. Kapsam
üyeliği de gerekir. `delegationWithin`, değiştirme ve geri alma dahil yönetimin dokunduğu her
hücreyi sınar; onay gereğini koşulsuz allow'a çeviremez, yöneticinin kendi kısıtını kaldıramaz.

| Adım | Gerekli politika hücresi ve diğer kontroller |
|---|---|
| Başarısızlıktan sonra devam / kapatma | Açık `run-decision` / Run kimliği / `resume` veya `close`; ayrıca `run/reserve` veya `run/cancel`. Durum ve revision geçişe izin vermeli. |
| Görevi kabul / ret | Açık `task-decision` / Task kimliği / `accept` veya `reject`; ayrıca attempt `evaluate`. AI isteği yine komuta bağlı onay kartı açar; kararı approval `decide` ve eşleşen görev adımı ister. Kabul kriterleri korunur. |
| Görev sorusunu yanıtlama | Açık `task-decision` / Task kimliği / `answer`; ayrıca attempt `evaluate`. Bekleyen soru, yanıt ve revision doğrulanır. |
| Sıradan onay | Açık `approval` / onay kimliği / `decide`; güncel politika, oturum, istek özeti, süre, görev ayrılığı ve güvence. Korunan/riski bilinmeyen kartlar tabanda kalır. |
| Operator hold durdurma / sürdürme | Sıradan operatör kontrolü `run/cancel` veya `run/reserve` kullanır; başarısızlıktan devam ayrı karar adımıdır. |
| Admission, operasyon, havuz, model, harcama, iş hedefi | `deckent policy vocabulary --json` sözlüğündeki sıradan hücreler. Tabanda olmamak, her taşımanın eylemi sunduğunu veya uygulamanın izin verdiğini garanti etmez. |

Karar adımında allow, aktörü ve eylemi açıkça adlandırmalıdır: `principals: "all"` veya
`actions: "all"` adım devretmez. Kaynak kimliği/kapsam seçilebilir; en dar kümeyi kullanın.
Genel `evaluate` veya `reserve`, kabul veya başarısızlıktan devam yetkisi değildir.

Yeni ilk kurulum politikası kuran insana yetki, MCP aktörüne yalnız gözlem kuralları verir.
Varsayılanda AI karar adımı veya yazma yetki grubu devredilmez. Mevcut özel kurulumlar kendi
grant'lerini korur; yükseltme önizlemesi sıfırlama veya yetki verme değildir.

## Mevcut yüzeylerle inceleme, yetki verme ve geri alma

Kurulu projeden çalıştırın. `SCOPE_ID`, `GROUP_ID`, `PREVIEW_DIGEST` ve grant kimlikleri yer
tutucudur; kurulumunuzda incelediğiniz gerçek değerlerle değiştirin. Yazımlar yöneticinin
kendi yetkisini ve etkileşimli onayını ister. Uygulamadan önce inceleyin.

```sh
deckent policy vocabulary --json
deckent policy status --scope SCOPE_ID --json
deckent policy mcp list --scope SCOPE_ID --json
deckent policy mcp grant --scope SCOPE_ID --group GROUP_ID --preview --json
deckent policy mcp grant --scope SCOPE_ID --group GROUP_ID --apply --expect PREVIEW_DIGEST --json
deckent policy mcp revoke --scope SCOPE_ID --group GROUP_ID --preview --json
deckent policy mcp revoke --scope SCOPE_ID --group GROUP_ID --apply --expect PREVIEW_DIGEST --json
```

Her eylemin taze önizleme özetini kullanın. Bayat görünüm, eksik yetki, taban çatışması veya son
yönetici ihlali değişikliği reddeder. Terminal `/policy` paneli aynı kayıtlı MCP gruplarını ve
önizleme/onay yolunu sunar; genel politika editörü değildir. Grupları ve etkin durumu kopya
örnekten değil `list` çıktısından alın. Geri alma yalnız grubun yönettiği grant'leri kaldırır;
özel/rol grant'leri eyleme izin vermeyi sürdürebilir. Ardından **effective** (etkin) durumu
inceleyin. Geri alma geçmiş etkileri silmez.

Kalıcı araç izinleri ve şablon bakımı ayrı komutlardır:

```sh
deckent policy grants --mine --scope SCOPE_ID --json
deckent policy revoke STANDING_GRANT_ID --scope SCOPE_ID --json
deckent policy upgrade --template current --scope SCOPE_ID --preview --json
```

`grants` (`--mine` ile ya da onsuz) bütün devir hücrelerini değil, kendi kalıcı araç onaylarınızı listeler; herkesin
onayları (`deckent policy grants --all [--after PAGE_MARK]`) verilebilir okuma eylemi `policy`/`inspect-standing-grants` ister
(ilk kurulum şablonu v13 bunu kuran kişiye verir; bir politika kuralı adlandırmadıkça hiçbir AI aktörü almaz). Önce politika karar
verir; eylem yoksa komut `CLI_POLICY_GRANTS_ALL_UNAVAILABLE` ile reddeder ve başka hiçbir şey okumaz. İzin varsa sınırlı bir sayfa
gösterir (kişi, kural, araç, maskelenmiş desen, kapsam, başlangıç: kuralı oluşturan mühürlü denetim değişikliği, elle yazılmış
kural için "—") ve sonraki sayfanın komutunu verir.
Kendi terminalinizde `deckent policy` scope özetini (yöneticiler, kalıcı onaylarınız, AI adımları ve MCP grupları açık/kapalı)
gösterir; `deckent policy mcp` / `deckent policy delegations` ile grup ya da adım seçer, değişikliğin önizlemesini kartta
okur ve yukarıdaki komutlarla aynı yönetilen değişiklikle uygularsınız.
`policy revoke` rastgele politika grant'ini değil, bu kayıtlardan birini kaldırır.
TTY dışındaki kalıcı izin geri alımında `--yes` teyit bayrağı vardır; yetki, politika veya AI
tabanını aşmaz.

## İnsan adımlarını AI aktörüne devretme

CLI ve terminal `/policy` → **Yapay zekâya devir** bölümü tek sürümlü komutu kullanır.
Önce listeleyin; aynı envanterden adımı seçin ve y/N kartındaki aktör, kapsam, kaynak sınıfı/kimliği
ve politika revizyonunu inceleyin. CLI kartı ok tuşlarıyla ya da `y`/`n` ile yanıtlanır (değişiklik görünümü yeniden okur,
kart tam onu gösterir); terminal kartı yalnız `y` ile onaylar.
Terminal kartında Enter, N ve Escape vazgeçer. Yazım doğrulanmış etkileşimli girdi/çıktı ister;
`--yes` geçişi yoktur. SDK `inspectConfiguredDecisionDelegations(root, query, options)` yalnız
okur. MCP yazma veya yeni karar aracı sunulmaz.

```sh
deckent policy delegations --scope SCOPE_ID --json
deckent policy delegate --scope SCOPE_ID --step run-resume --resource RUN_ID --actor mcp
deckent policy undelegate --scope SCOPE_ID --step run-resume --resource RUN_ID --actor mcp
deckent policy delegate --scope SCOPE_ID --step task-accept --resource TASK_ID
```

Adımlar `run-resume`, `run-close`, `task-accept`, `task-reject`, `task-answer` ve
`approval-decide` olur. Varsayılan ve desteklenen tek `--actor`, doğrulanmış insanın MCP
kimliğine bağlı `mcp` değeridir. `--resource` hücreyi tek Run, Task veya onay kimliğine daraltır;
yalnız o kapsamdaki bütün kaynak sınıfını devretmek istediğinizde kaldırın. Terminal bölümü
kapsamın bütün sınıfını kullanır. Korunan adımlar listelenmez, korunan onay kimlikleri reddedilir;
sınıfın bütünü devredilse de taban uygulanır. Diğer yürütme/onay hücreleri ayrıca bulunmalıdır;
bu komut onları örtük olarak vermez.

Liste **yönetilen grant** ile **etkin izni** ayırır. Undelegate yalnız aynı kapsam, adım ve
kaynak seçiminin yönetilen kuralını kaldırır; özel veya rol kuralı adıma izin vermeyi sürdürebilir.
Eşzamanlı politika değişimi eski kartı reddeder; tekrar inceleyip onaylayın. Uygulanan her değişiklik
`policy.administer@1`, beklenen revizyon, onay, yetki sınırı, audit ve arşiv yolundan geçer;
onay/audit insana ait granter kimliğini kaydeder. Genel `deckent operation execute` ve açık SDK
yürütmesi `policy.administer@1` işlemini hâlâ `OPERATION_SURFACE_RESTRICTED` ile reddeder.
Korunan yetki dosyalarını elle düzenlemeyin.

## Örnekler ve sınırları

**“AI kendi başarısız Run'larını sürdürsün.”** AI kimliğini, kapsamı ve önceden incelenmiş Run
kimliklerini seçin. Aşağıdaki JSON, özel devir komutunun ürettiği hücreyi açıklar;
çalıştırılabilir CLI girdisi değildir. `run/reserve` ayrıca verilmelidir; undelegate aynı
kaynak seçimiyle yönetilen grant'i kaldırır. Dinamik “kendi Run'ları” koşulu veya gelecekteki Run
kimliklerine otomatik devir yoktur.

```json
{
  "id": "selected-run-resume",
  "effect": "allow",
  "principals": [{ "issuer": "HOST/mcp", "subject": "SUBJECT" }],
  "actions": ["resume"],
  "scopes": ["SCOPE_ID"],
  "resource": { "kind": "run-decision", "ids": ["RUN_ID"] }
}
```

Gerekli hücreler verildikten sonra mevcut CLI geçişi
`deckent run resume --scope SCOPE_ID --id RUN_ID --command-id COMMAND_ID --expected-revision REVISION --json`
olur. Komut çağıran CLI aktörünü kullanır; MCP kimliğine bürünmez. Tanıklı insan, AI devir
hücresi olmadan devam edebilir; ortak AI girişi açık hücre ister.

**“AI N tutarının altındaki görevleri kabul etsin.”** Politika hücresinde sayısal tutar/risk/
kalite eşiği koşulu yoktur. İş kriterini ayrıca tanımlayın, kalıcı kanıtı inceleyin; belirli
Task kimlikleri için `task-decision/accept` seçin, attempt `evaluate` ve approval `decide`
yetkilerini de sağlayın. Uygulanmayan eşik yerine wildcard kullanmayın. AI kabul/ret isteği
yine kartından geçer; model görüşü, test başarısı veya politika allow tek başına iş kabulü
değildir. Mevcut CLI:
`deckent task accept --scope SCOPE_ID --run RUN_ID --task TASK_ID --command-id COMMAND_ID --expected-revision REVISION --json`
(`reject` aynı bayrakları alır). Onay inceleme/kararları sürümlü JSON kullanır; örneğin
`deckent approval inspect --input approval-query.json --json`; sorgu şekli
`{"schemaVersion":1,"scopeId":"SCOPE_ID","approvalId":"APPROVAL_ID"}` olur.

**“MCP salt okunur gözlemci olsun.”** İlk kurulum gözlem kurallarını koruyun; `policy mcp list`
çıktısını inceleyip yazma grubu vermeyin. Mevcut kurulumda istenmeyen her yönetilen grubu
yukarıdaki önizleme/uygulama yoluyla kaldırın; özel/rol grant'lerini de inceleyin. Başka
grant'ler varsa “yönetilen grup yok” salt okunurluk kanıtı değildir. Araç keşfi yetki değildir;
sıradan inceleme de uygun kapsam ve grant ister. MCP onay-karar aracı sunmaz.

## Karar geçmişi ve bütünlük

Karar kaydı v4, `deciderClass` taşır: `human-tty`, `ai-policy` veya `system`. Arayüz
“Etkileşimli terminal”, “Policy üzerinden AI” veya “Sistem” gösterir; eski kararın sınıfı
bilinmeyebilir ve insan diye etiketlenmez. Kayıt aktörü, gerekçeyi, istek bağını ve politika
revision'ını da korur. Run yaşam döngüsü kanıtı/audit, sınıfı ve kural veya onay kimliğini
kaydeder. Sınıf, kararın hangi yetki yolundan geldiğini anlatır; iş sonucunun doğruluğunu değil.

```sh
deckent audit verify --scope SCOPE_ID --json
deckent audit verify --scope SCOPE_ID --export-checkpoint > checkpoint.json
deckent audit verify --scope SCOPE_ID --checkpoint checkpoint.json --json
deckent audit rebaseline --scope SCOPE_ID --reason "Reviewed authority change" --json
```

Verify; bilinmiyor/erişilemiyor/checkpoint yok dahil eşleşmeyen her durumda sıfır dışı çıkar.
Okuma iyileştirme veya referans kaydı oluşturmaz. Politika/producer kayması, kırık zincir ve
bazı silmeler mühürlü checkpoint'lerle saptanır. Dışa aktarılan tanığı yazılabilir hesabın
dışında saklayın: aynı hesaba erişen saldırgan bütün marker ve checkpoint'leri kaldırırsa
yerel görünüm yeni kurulum gibi olabilir. Rebaseline, sebep araştırıldıktan sonra yapılan,
AI tabanında bulunan tanıklı insan y/N işlemidir; yeni referans kurar, geçmişi güvenli ilan
etmez. Donanımla korunan FIDO2 onayı ve imzalı politika paketleri beta sonrası iştir, bugünkü
koruma değildir. [Audit sınırları](architecture-overview.tr.md#audit-bütünlüğü-ve-pull-witness).

## Uyum raporu neyi kanıtlar

Kilitli geliştirme bağımlılıkları olan kaynak checkout'ta `npm run report:ai-floor`,
[Markdown](reports/ai-floor-compliance.md) ve [JSON](reports/ai-floor-compliance.json) üretir;
`npm run report:ai-floor -- --check` yazmadan kaymayı reddeder. Buradaki ve İngilizce eşindeki
floor tablosu aynı iki dilli envanterden üretilir. Sözleşme testi CI'da tek `ai-floor:` özeti
yazar; herhangi bir `İHLAL` veya kaydedilmiş çıktıyla fark testi kırar. Beklenti üretim floor
fonksiyonundan bağımsızdır; sır korumasını silen yalıtılmış kaynak-yükleyici mutasyonu ihlal
üretmeli ve sıfır dışı çıkmalıdır.

Yayımlanmış her eylem ve floor ailesi; hücresiz AI, açık grant'li AI ve insan `os-user`
fixture'ı ile değerlendirilir; eski MCP, workload ve token aktörleri de sınanır. Açık adım
testleri wildcard/yok/geri alınmış/yanlış kapsam grant'lerini, ret ve onay gereğini kapsar.
Açık uçlu kimlik ve ayar yolları sınır örnekleriyle temsil edilir. Bunlar saf değerlendirici
kontrolleridir; gerçek TTY, servis, sır deposu, OS yalıtımı, ERP veya canlı kabul kanıtı değildir.
Uygulama kartı güvenliği ayrıca sınanır. Dogfood'da Git testleri bir adapter'ın kanıtıdır;
müşteri ERP/CRM sonucunu aynı kimlik/kapsam/operasyon/onay sözleşmeleriyle iş kriteri ve kalıcı
makbuz üzerinden kabul eder.

Komut kaynakları: [policy grants/status/upgrade](../src/surfaces/core/cli-approval/internal/policy-grants.ts),
[MCP politikası](../src/surfaces/core/cli-approval/internal/policy-mcp.ts), [Run](../src/surfaces/core/cli-run/internal/run.ts),
[Task](../src/surfaces/core/cli-task/internal/task.ts), [onay](../src/surfaces/core/cli-approval/internal/approvals.ts),
[audit](../src/surfaces/core/cli-admin/internal/audit.ts). Karar kuralları:
[adım grant'i](../src/domain/core/policy/internal/decision-step.ts),
[yaşam döngüsü broker'ı](../src/engine/core/runs/internal/decision-approval.ts),
[kart yetkisi](../src/engine/core/approval/internal/application.ts).

Devir kaynakları: [CLI](../src/surfaces/core/cli-approval/internal/policy-delegations.ts), [application](../src/engine/core/approval/internal/delegations.ts), [inventory](../src/domain/core/policy/internal/delegations.ts).
