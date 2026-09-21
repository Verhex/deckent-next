# Anlık iş akışı — geçici

Fable/uzun goal kapalı. Owner checkpoint teslimi; kalıcı yön PLAN/ARCHITECTURE.

## Teslim — otomatik Run turlarında sıra devri

Önce host, bir Run'ın sonlu grafiğini bitirene kadar diğer Run'ı bekletiyordu. Şimdi otomatik
ilerleme `runRuntime.maxReservationsPerTurn` kadar rezervasyon çağrısından sonra yeni iş
almayı bırakır; mevcut reserved/started işleri tamamlayıp değerlendirir, sonraki paged Run'a
geçer. Varsayılan4; worker limiti değildir. Denenen waiting/changed rezervasyon da bütçeyi
kullanır. Sayfa/cursor mevcut kalıcı niyet listesinden gelir; yeni kuyruk otoritesi kurulmadı.

- Engine/run-progression: optional tur rezervasyon bütçesi; tamamlanma bazlı refill bütçe
  içinde devam eder. Eski scheduler, pool, kabul, policy/iptal ve drain sahipliği değişmez.
- Composition/run-progression host bütçeyi config'den enjekte eder. Açık doğrudan advancement
  çağrısı tam sonlu tur davranışını korur; public rezervasyon API'sinin yetkileri genişlemez.
- Config registry + EN/TR alan açıklaması güncellendi. Yeni kalıcı kayıt/migration/protokol yok.
  Ortak runtime'daki otomatik niyetlere uygulanır; CLI/SDK/MCP ayrı scheduler kurmaz.

Kanıt: 28 test/2 dosya (gerçek Docker dahil) geçti. Ortak tek slot ve pageSize1/bütçe1 ile
r:ilk iş kabul, r:ikinci pending → z:iş kabul → r:ikinci kabul sırası doğrulandı. Tekrarlanan
binding yok. Bütçe2 ile C'nin alakasız yavaş B bitmeden başlayabildiği ayrıca doğrulandı;
10 engine testi tekrar geçti (önceki koşumla örtüşür). Build/types, ESLint, mimari0 ve smoke
geçti; full suite tekrarlanmadı.
Proof: `/home/alperen/deckent-refactor-work/proof/RUN-FAIR-ROTATION/verification.json`.

Jev ilk çağrıda ayrıntılı kontrol sorularının eski artifact bağlamından kaldığı fark edildi;
o alt skorlarla karar verilmedi, hata/inconclusive loglandı. Gerçek proof + doğru fairness
sorularıyla yeni çağrı `931f8668-691e-4fdd-be86-cb8931011fb2`: bounded_rotation1.0,
insufficient_information0, none_of_the_above0; yeterlilik0.64. Bağımsız PASS değildir.

## Açık sınır

Çalışan worker kesilmez. Yavaş tek iş ve önceden ayrılmış işler turun dönüşünü geciktirebilir;
son drain sırasında boş slotlar oluşabilir. Kesin zaman/CPU payı, eşzamanlı çoklu-Run arbiter'ı,
restartlar arasında kalıcı sıra kredisi ve fleet/HA bu dilimde yapılmadı. Varsayılan4 ölçülmüş
optimum değildir, dogfood ile ayarlanabilir. Yeni işe başlanmadı.

## Checkpoint doğrulaması

Tam verify: 1460 ürün/254 dosya, 24 native, 29 host geçti. İlk koşumda tarihsel DB
fixture'larındaki 38 hata bulundu; v25 tablolarını bırakan eski sürüm hazırlıkları ve eksik
v13 execution şeması düzeltildi. 119 ilgili test ve ardından tam verify geçti. Ürün migration'ı
gevşetilmedi. Canonical core-memory26 dosya birebir eşleşti. Commit/push kimliği Git geçmişi
ve external CHECKPOINT-2026-09-21 proof'unda tutulur; yeni feature işi başlatılmadı.
