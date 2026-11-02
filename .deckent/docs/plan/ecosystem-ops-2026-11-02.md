# Ekosistem ve operasyon işleri — Codex analiz devri (2026-11-02)

Kaynak: owner'ın Codex analiz oturumu, kanal `opus` 2977. Owner 2026-11-02'de ana oturumdan bunları plana işlemesini istedi. Bu belge plan kaydıdır. Uygulama başlangıcı, beta kapısı, mimari karar ya da merge/canlı izni değildir. Sıralama mevcut beta ve owner kabul sırasının arkasından gelir; uygulama için her madde ayrı owner kabulü ister.

Analiz kanıtı main `70f78904b` üzerine kuruldu. O sırada test, build ve runtime koşulmadı. Yan dallardaki alpha.62 işi main kabiliyeti sayılmadı. Her madde iş başlarken güncel HEAD ile tekrar doğrulanır.

## Mevcut işlerle eşleşme

| # | İş ve çözdüğü sorun | Mevcut kimlik | Bağımlılık / sahip | Çıkış kanıtı |
|---|---|---|---|---|
| 1 | **Test tip denetimi.** Sorun: `tsconfig.json` yalnız `src`'yi kapsıyor, Vitest tip denetimi yapmıyor. "Test çalıştı" ile "test dosyası tip açısından denetlendi" farklı kanıtlardır. | PLAN FIX10 (yeni iş açılmaz) | Test-revizyon sahibi; TS config ve CI tek yazarı. #8'i beklemez. | Değişen testte bir tip uyumsuzluğu kapıyı kırar, düzeltme geçirir. Mevcut runtime ve negatif kapsam korunur. Kaynak: <https://vitest.dev/guide/testing-types> |
| 2 | **Durum bilgisinin tazeliği.** Sorun: PLAN, `follow-up-works/current-flow.md` ve pano farklı sürümler anlatıyor. Yeni oturum yanlış sürüm ve iş sırası çıkarabilir. | Lead belge sorumluluğu | Sürüm makbuzu/SHA'dan türeyen alanlar. İkinci bir durum otoritesi yok. | Tek sürüm için kaynak kimliği ve tarih görünür. Plan, kod, kanıt, canlı ve owner kabulü ayrı kalır. Bu tur: current-flow ve pano alpha.61/alpha.62'ye güncellendi. |
| 3 | **Genel operasyon yolculuğu.** Sorun: insan bir operasyonu uçtan uca takip edip çözemiyor. Çalışmış işlem listesi yok, inspect için commandId bilinmeli, JSON zorunlu, doğrulanamayan `unknown` çözümsüz kalabiliyor, hazır ERP adapter'ı yok. | BETA-RAKIP-1…4, RESTART-RECOVERY W11 | Operation/effect ve yüzey sahipleri. Ortak takip Core'da, gerçek ERP adapter'ı Enterprise'da. İkinci effect/recovery motoru yok. | Akış: işlem seç → girdileri doldur → önizle/onayla → izle → hedefte doğrula → belirsizliği ele al. Bir gerçek dış süreçte kalıcı sonuç. Cevap kaybı, eski sürüm, yanlış scope, çift gönderim, iptal ve yeniden bağlantıda ikinci etki olmaz. `unknown` zorla "başarılı" yapılmaz. |
| 4 | **MCP için OAuth.** Sorun: MCP istemcisi yalnız statik header taşıyor, OAuth korumalı MCP sunucusuna bağlanamıyor. | MCP-OAUTH (roadmap-2026-10-15, korunan kuyruk) | MCP adapter + kimlik/sır sahibi. Mevcut OAuthConnectionApplication ve sır custody'si kullanılır. Token sahibi olmak Deckent policy yetkisi vermez. | Gerçek OAuth korumalı MCP bağlantısı. Negatifler: yanlış resource/issuer, süresi dolan token, refresh yarışı, revoke, redirect/SSRF, sır sızıntısı. Spec 2026-07-28: CIMD önerilir, DCR deprecated. Kaynak: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> |
| 5 | **OpenTelemetry.** Sorun: yerel bounded iz deposu ve metrikler var, ama standart dışa aktarım yok. Kullanıcı gecikmenin kaynağını göremiyor. | owner-decisions açık OTel/MCP tasarım soruları; telemetry kararı 2026-10-24 | Gözlem/Nervous adapter sahibi. İsteğe bağlı, tembel SDK. Varsayılanda içerik ve sır dışarı gitmez. Telemetry ledger veya kabul sahibi değildir. | Sahte collector ile Run → Task → Attempt → model/tool → effect korelasyonu. Kapalı kip. Collector yokken kaynak sınırı korunur. Redaction. GenAI sözleşmeleri "Development" durumunda; sürümlü eşleme gerekir. |
| 6 | **A2A istemcisi.** Sorun: dış ajanlarla standart protokolle iş birliği yok (owner hedefi 2026-09-22). | Yeni outcome; MCP/A2A ekosistem hedefi | Dış ajan/effect adapter + kimlik/policy sahibi. Somut partner, binding/sürüm, endpoint güveni ve kota tanımlanır. İlk kapsam yalnız client; inbound server ayrı yetki sınırıdır. | Gönder → bağlantı kaybı → restart → aynı dış işi bul → kanıtla uzlaştır. Negatifler: çift etki, yanlış scope, sahte/değişen Agent Card, geç cevap, iptal yarışı, auth-required/input-required. SendMessage idempotency yalnız MAY. Dış "completed" yerel kabul değildir. SDK `@a2a-js/sdk` 1.3.0, spec 1.0.0. |
| 7 | **MCP Tasks uyumu.** Sorun: MCP sunucusu yalnız tools sunuyor; uzun işler standart durable handle ile izlenemiyor. | Yeni küçük değerlendirme | MCP yüzey sahibi. Yeni task engine yok. MCP aktörü onay veremez (MCP-NO-DECIDE). | Önce destekleyen gerçek bir istemcide kazanım gösterilir. Sonra bağlantı koptuktan sonra aynı handle; scope, TTL, iptal ve karar yetkisi negatifleri. |
| 8 | **TypeScript 7 geçişi.** Sorun: TS 5.9.3; native derleyici hız sağlayabilir ama lint araçları JS compiler API'sine bağlı. | DEPS-TS (dependencies.json) | Build/lint/CI tek yazarı. Önce yan yana, kapıyı etkilemeyen ölçüm; salt sürüm artırımı yok. | Aynı SHA'da tanı farkı, declaration uyumu, süre/bellek ölçümü, arch/lint negatifleri ve geri dönüş. Vendor hız oranı Deckent sonucu sayılmaz. |
| 9 | **ACP (Agent Client Protocol).** Sorun: her yerel CLI ajanı için ayrı olay ayrıştırıcısı yazılıyor. | Yeni koşullu araştırma | Native worker adapter sahibi; gerçek destek matrisi. A2A veya operasyonun önkoşulu değildir. Kazanç yoksa alınmaz. | Destekleyen tek ajanla karşılaştırma: oturum, yeniden bağlanma, iptal ve yetki reddi. Adapter maliyetinin azaldığı somut olarak görülür. Paket `@agentclientprotocol/sdk` v1. |

## Önerilen sıra (owner kabulüne tabi)

1. FIX10 ve durum uzlaştırması (#1, #2). Küçük ve bağımsız.
2. Gerçek operasyon yolculuğu (#3). Beta müşteri yolculuğunun çekirdeği.
3. MCP-OAUTH ve OTel ölçümü (#4, #5).
4. Somut partnerle A2A client (#6).

DEPS-TS (#8) bağımsız bir ölçüm olarak her an yapılabilir. MCP Tasks (#7) ve ACP (#9), ancak somut bir tüketici ve kazanım varsa sınırlandırılıp açılır.

Bu araştırma şunları gerekçelendirmedi: ikinci orchestration motoru, toplu framework değişimi, ölçümsüz SQLite → başka DB geçişi.

## Owner'a açık sorular (uygulama öncesi)

- #3: doğrulanamayan `unknown` için kanıt ile insan beyanı ayrımı.
- #5: içerik yakalama, audit/SIEM ve `OTEL_*` config.
- #6: ilk partner ve senaryo.
