# Qwen geliştirme içi karar pilotu

Owner 2026-10-05: ürün yüzeyinden ayrı host pilotu; sonraki yönlendirme **chat kullanılmayan zamanlar**.
Araç hazırdır, Jev'in otomatik ikamesi değildir. Native chat/agent profili ve vLLM konteyner ayarları değişmez.

Bu kaynak araç `base-next-token` seçenek puanlamasını kullanır; eğitilmiş karar başlığı içermez.
Frozen-backbone başlık eğitimleri, ağırlıklar, veri setleri ve doğrulama kanıtı ayrı dış araştırma
alanındadır. Host aracının commit/PR teslimi model kalitesi veya Hugging Face yayın kabulü değildir.

Varsayılan config yalnız genel, repo-göreli token/journal dosya referansları taşır; credential değeri
ve kişisel mutlak yol içermez. Yeni worktree kendi host kökünü kullanır. Var olan geliştirme host'unun
config ve private state'ini açıkça kullanmak için `DECKENT_QWEN_DECISION_CONFIG` mevcut config
dosyasını seçebilir. Ana checkout veya gölge betiği yolu kendiliğinden değiştirilmez; main teslim
sonrasında gerçek CLI checkout yolunu ve Jev hazırlık sürümünü doğrular.

## Kullanım

Cwd `/home/alperen/deckent-next`. Vaka biçimi mevcut `jev-workflow.md` schemaVersion 2'dir:
north star + süreç + gözlenmiş kanıt + kazanç/kayıp + en az iki gerçek seçenek ve kontrol.
İki ayrı çekimser seçenek hazırlamada otomatik eklenir. `prepare` model çağırmaz.

```sh
node .agents/refactor/qwen-decision.mjs prepare /absolute/case.json
node .agents/refactor/qwen-decision.mjs ask /absolute/case.json
node .agents/refactor/qwen-decision.mjs inspect <callId>
node .agents/refactor/qwen-decision.mjs record <callId> /absolute/decision.json
node .agents/refactor/qwen-decision.mjs outcome <callId> /absolute/outcome.json
node .agents/refactor/qwen-decision.mjs report
```

`ask CASE CALL_ID` aynı UUID ve aynı vaka/config digest'iyle makbuzu tekrar okur; yeniden model çağırmaz.
Kaybolmuş veya yarım kalan sonuç `unknown` kalır. `ask CASE` her çalıştırmada yeni, açık bir çağrı başlatır;
başarısızlığı otomatik telafi etmek için tekrar kullanılmaz. Aktif/bekleyen vLLM isteği varken yeni
çağrı `QWEN_SERVER_BUSY` ile model isteği göndermeden reddedilir; mevcut makbuzlar yine okunabilir.
Metrik okunamaz/eksik/model kimliği farklıysa çağrı da kapalı kalır (`QWEN_ACTIVITY_UNKNOWN`).
Model çağrısının ortasında başka iş başlarsa tamamlanmamış vaka `unknown` olabilir.

Kayıtlar `.deckent/host/qwen-decisions/` altındadır; Jev kayıt alanı ayrıdır. Karar/seçim kaydetmek
eylem, onay, bağımsız PASS veya ürün DOGFOOD yetkisi vermez. Yerel çağrı otomatik Jev fallback'i yapmaz.

## İç HTTP API

Token dosyası bu pilotta oluşturuldu (0600); anahtar komut çıktısına yazılmaz. Yeni kurulumda
`node .agents/refactor/qwen-decision.mjs init-api` yalnız bir kez çalıştırılır, mevcut dosyayı değiştirmez.

```sh
node .agents/refactor/qwen-decision.mjs serve
```

Sunucu yalnız `127.0.0.1:18081` üzerinde foreground çalışır; ürün servisine/daemon'a kayıt eklemez.
`POST /v1/decide`, `Authorization: Bearer <private-token>` ve `Content-Type: application/json` ister.
Gövde `{ "commandId": "<gerçek UUID v4>", "case": { ...schemaVersion2 vaka... } }`.
Token `.deckent/host/qwen-decision-api-token` dosyasından istemci içinde okunur; URL/shell geçmişine konmaz.
`GET /health` de kimlik doğrulamalıdır. Origin taşıyan tarayıcı çağrıları reddedilir.
Bir istek işlenirken ikincisi 429; aktif Qwen isteği varken 503; digest çelişen replay 409;
belirsiz model sonucu 503 + `status: unknown`. Token ve journal yolu HTTP cevaplarına girmez.
Ürün API/CLI/MCP kataloğunda hiçbir yeni yüzey yoktur. Teslimde geçici test sunucusu durduruldu;
kalıcı servis/otomatik başlangıç kurulmadı.

Config `.agents/refactor/qwen-decision.config.json`; isteğe bağlı `DECKENT_QWEN_DECISION_CONFIG`
başka bir host config dosyasını seçer. Yalnız literal loopback vLLM endpoint'i kabul edilir.

## Davranış ve sınırlar

Her soru düşünme kapalı bir ayrı istektir; tokenizer tek-token A/B/... kodlarını doğrular.
`logprob_token_ids` tüm seçeneklerin ham next-token puanlarını getirir. Seçim sampled text'e değil
en yüksek seçenek puanına dayanır. JSON'u host kodu kurar; model confidence sayısı uydurmaz.
Olasılıklar geçerli seçenek kodlarına göre normalize edilir. `confidence` yalnız dağılım yoğunluğudur;
`calibration: not-measured` korunur. Jev'in 0,90/0,75 eşikleri bu sağlayıcıya otomatik taşınmaz.
Geçerli kodların ham toplamı config alt sınırından (0,8) düşükse yüksek güven uydurulmaz, sonuç unknown olur.
Timeout, iptal, eksik logprob veya HTTP hata belirsiz sonuçtur; gizli retry yoktur.

Her soru öncesinde exact model için `running=0` ve `waiting=0` metriği gözlenir.
**Bu gözlem scheduler kilidi değildir:** native chat kontrol sonrasında başlayabilir. Caller chat'i
sessiz tutmalıdır; idle-only kullanım, mutlak çakışma engelleme veya terminal etkisizliği garantisi değildir.

`--max-model-len 196608` giriş+çıkış için istek başına tavandır, chat'e özel 200k rezervasyonu değildir.
Modelin 262k eğitim bağlamından 196k çıkartarak karar motoruna kalan kapasite hesaplanmaz.
Ağırlık/KV havuzu ortaktır; uzun aktif chat bellek ve işlem baskısı oluşturabilir. Bu pilotta kısa
karma yükteki üç hata `chat_completion/serving.py:1259` logprob listesinde `IndexError` idi;
kapasite dolması/OOM kanıtı saptanmadı. vLLM/MTP kök düzeltmesi bu host diliminin dışında bırakıldı.

## Tutulan ölçüm — 2026-10-05

İlk pilot: mevcut Qwen3.8-27B-INT4-W4A16, vLLM 0.30.0; sekiz insan tarafından yazılmış sentetik
geliştirme vakası (4 true/4 false), aynı hazırlanmış vakalarla taze Jev çağrıları. Her vaka üç sorudur.

| Ölçüm | Yerel Qwen | Jev |
|---|---:|---:|
| Tam karar | 7/8 | 8/8 |
| Doğru seçim / tüm denemeler | 7/8 | 8/8 |
| Tam kararlarda p50 | 1479 ms | 264 ms |
| Tam kararlarda p95 (bu küçük sette maksimum) | 1511 ms | 324 ms |

Bir Qwen vakası düşük kod kütlesiyle unknown kaldı. Bu sayı bir abstention seçimi değildir.
Kararlar genel ürün doğruluğu/kalibrasyon kabulü değildir; hatalı/unknown istekler latency yüzdeliklerinin
dışındadır ve tamamlanma sayısında görünür. Rich dört-soru tasarım vakası 3162 ms, Jev 321 ms idi.
Sıcak aynı-vaka uçtan uca HTTP denemesi 376 ms; idle-guard sonrası canlı vaka 367 ms.
Cache-sıcak tekrar farklı yeni vakaların 1,5 s maliyetinin yerine konmaz.

Üç karma chat denemesinde chat tamamlandı, **kararların üçü HTTP500/unknown** oldu. Chat p50'nin
1331→1307 ms olması karar motorunun paralel çalıştığını veya chat'i hızlandırdığını göstermez.
Native terminalin gerçek agent oturumu ölçülmedi; bunlar kısa doğrudan HTTP chat vekil iş yükleridir.
GPU bellek gözlemi 31094–31224 MiB. 5 s idle GPU baseline 66,792 W; 10,151 s gözlenen local-quality
aralığında kaba idle çıkarılmış GPU tahmini yaklaşık 0,155 Wh/**denenen vaka**; edge gaps, başarısız vaka
ve ortak GPU işleri attribution sınırıdır. Priz ölçümü/per-request enerji garantisi değildir.

Üç gerçek tarihsel geliştirme vakası da yeniden Qwen'e verildi: 3/3 tam karar, beş korunmuş
operatör etikette 4/5 uyuşma (korunmuş Jev cevapları da 4/5). Bağımsız etiket kanıtı tekrar
koşturulmadı; bazı etiketler sonradan konduğundan bu sayı taze doğruluk kabulü değildir.
Bu zengin vakalar 2,91–6,12 s sürdü; tarihsel Jev gecikmeleriyle zamansal karşılaştırma yapılmaz.

Final idle-only producer kanıtı: model boşken advice, aktif HTTP chat gözlenirken
`QWEN_SERVER_BUSY`, yeni intent/model çağrısı yok. Tam API/auth/replay ve cancellation yolları hedefli
testlendi. Final kimlik doğrulamalı HTTP vaka 362 ms + replay/401 geçti. Typecheck/eslint/lint-arch
geçti; client/store 11 + API 5 test (16), mevcut Jev transport 9 + review 21 test (30) geçti.
Bağımsız reviewer PASS ve hosted/live ürün kabulü bu pilotta alınmadı; commit/push yapılmadı.

Kaynak/proof: `/home/alperen/deckent-refactor-work/proof/QWEN-DEV-DECISION-2026-10-05/`.
Kalan: daha çeşitli gerçek geliştirme vakalarıyla etiketli kalite/kalibrasyon; idle-only yeni-vaka ölçümü;
paralel kullanım ayrıca kabul edilirse vLLM logprob/MTP uyumluluğu ve gerçek terminal etkisi ayrı dilim.

## Tekrar üretme

```sh
node .agents/refactor/qwen-decision.test.mjs
node .agents/refactor/qwen-decision-api.test.mjs
node .agents/refactor/qwen-decision-benchmark.mjs /absolute/private-proof-dir
```

Benchmark açıkça canlı model çağırır; olağan testlere dahil değildir. `--compare-jev` eklenirse
her sentetik vaka için kayıtlı yeni ücretli Jev çağrısı yapar. Güncel benchmark idle-only'dir;
ilk karma yük başarısızlığının retained evidence'ını silmez veya yeniden etiketlemez.

Resmî kaynaklar 2026-10-05 kontrol edildi:
[vLLM 0.30.0 API](https://docs.vllm.ai/en/v0.30.0/serving/online_serving/openai_compatible_server/),
[vLLM 0.30.0 engine args](https://docs.vllm.ai/en/v0.30.0/configuration/engine_args/),
[vLLM metrics](https://docs.vllm.ai/en/v0.30.0/design/metrics/),
[Qwen3.8 model kartı](https://huggingface.co/Qwen/Qwen3.8-27B),
[tek-token karşılaştırma araştırması](https://arxiv.org/html/2609.37647v1),
[paket registry](https://pypi.org/project/vllm/).
