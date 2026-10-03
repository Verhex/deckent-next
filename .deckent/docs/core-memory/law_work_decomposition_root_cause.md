# İş bölme ve kök neden

Arızanın nedeni, başarısız varsayım ve tekrarı önleyen mekanizma belirlenir; negatif kanıt eklenir. Değişmeyen hata kör retry ile tekrarlanmaz. Incident/closure paketi yalnız kendi closure'ını taşır; yeni ürün kazanımı ayrı kabul edilmiş outcome'dur (amend. 2026-08-17).

- İşler gerçek sorumluluk/dependency grafiğine bölünür; aynı kaynağa yazanlar serileştirilir. Task adedi ve paralellik instruction metninden değil effective config, DAG, collision/resource policy ve provider capacity'den çözülür. 3–5/8/20/40 sayıları tarihsel örnektir, minimum veya tavan değildir. Sabit sayı yerine mekanizma düzeltilir.
- Tek worker (`max_workers=1`), tek-task, erişilemez FIX veya attribution döngüsü throughput'u engelliyorsa kök neden ve etkisi görülür görülmez ownera raporlanır; düzeltme ölçülmüş kapasite ve bağımlılıkla yapılır. Yerel doğrulamanın iki fork sınırı ürün darboğazı sayılmaz.

Owner 2026-10-02 — **hız ve güvenlik ihlal edilemez:** kontrol yolu milisaniyelerde ilerler; insan ya da ajan hiçbir zaman kopuk, sahipsiz ya da süresiz beklemeye girmez — her beklemenin sahibi, görünür durumu, zaman aşımı ve sonraki eylemi vardır. Hız için güvenlik tabanı gevşetilmez; güvenlik için de asenkron ya da önceden hesaplanabilecek bir adım bloklayıcı yapılmaz. Kontrol yolunda yoklama yerine olay/push tercih edilir. Hedefler ölçülene kadar "hedef, ölçülmedi" etiketi taşır (olay → insan yüzeyi 500 ms p95, owner 2026-10-03); ölçülmüş eski davranış negatif test olur. Kaynak → neden → düzeltme → kanıt: legacy deterministik ama yavaştı (dakika ölçeğinde bekleme, 10 sn onay duyurusu, 2 sn tam tarama) → bekleme sahipsizliği ve yoklama → tipli, sahipli, süreli beklemeler ve push → ARCHITECTURE karar günlüğü 2026-10-02, Dalga 6 C18 (`proof/WAVE6-2026-10-03/`).

Legacy dersler: tekrar eden sprint-fix döngüleri semptom yamalarının ve eksik kabul kanıtının sonucuydu; ağır task paketleri ve sabit 3–5 task planlayıcı throughput'u düşürdü.


RUN-PROGRESSION-CONCURRENT (owner 2026-10-03; kaynak adayı, canlı kabulü değil): Run içi paralellik bağımsız Run ilerlemesini
kanıtlamaz. N1'de boş havuz slotları varken Run turunu await eden sayfa döngüsü seri çalışmayı korumuştu. Düzeltme iki ayrı
sınır taşır: `runRuntime.maxConcurrentRuns` etkin servis yürütme tavanından varsayılanını alır; servis FIFO yürütme kapısı
havuzun rezervasyon sınırından ayrıdır. Aynı scope/Run turu yoklamalar arasında tek sahipte kalır; kapanış bekleyen ve çalışan
işi drain eder. Kısmi hata başka Run'ı backoff'a sokmaz. Kontrollü sekiz-slot testi native worker/N1 kabulünün yerine geçmez;
kanıt ve açık yerel native sınırı dış `proof/RUN-PROGRESSION-CONCURRENT-2026-10-03/review.md` dosyasındadır.

POOL-CAPACITY (owner 2026-10-03; kaynak adayı): config `admission` slotları per-Run politikadır, kurulum-geneli ledger havuzunu
kendiliğinden yükseltmez. Kaynak → neden → düzeltme → kanıt: N1 ledger 2/2, config 8/8 → kurulum bypass ve değişmeyen durable pool →
aynı hold/resume yetki sınırında makbuzlu etkin kapasite override, doluluk altına küçültme reddi, açık drift ve salt-okunur bekleme →
dış `proof/POOL-CAPACITY-2026-10-03/review.md`. İlk pool kaydı installer replay için korunur; override, occupancy kontrolü, eski→yeni
makbuzu ve audit tek transaction'dır. Saniyelik poll'a bekleme yazımı eklenmez; türetilmiş güncel koşul tarihsel ret zamanı değildir.
Kontrollü sekiz rezervasyon, sekiz native worker'ın ölçülmüş paralelliği ya da N1 kabulü değildir; canlıya müdahale ayrı yetkidir.

TC-M ölçüm dersi (TERMINAL-S00-S01 source candidate, 2026-10-03): Ink `onRender.renderTime` stdout/ekran boyamasının uçtan uca süresi değildir. Sahte üreticiyle gerçek Workline'ın bellek TTY stdout yazımı ölçülebilir; cold boot/servis, fiziksel ekran, gerçek GPU/model ve uzun oturum ayrıca kanıt ister. Her sonuç sürüm/ortam/workload ve ham örnek taşır; clock yok/ters/eşit veya örnek eksikse `unmeasured`/null, sıfır değil. 500 ms p95 hedefi bu host koşusuyla kabul sayılmaz. Kaynak → neden → düzeltme → negatif kanıt: render callback'in dar sınırı → uçtan uca hız sanılma riski → stdout gözlemcisi + ayrı producer wall aralıkları → geçersiz clock ile tüm yedi yolun unmeasured testi; dış `proof/TERMINAL-S00-S01-2026-10-03/S00/`. K-LATENCY runtime kapsamı ayrıdır; base `0388c2cf`'de producer bulunmadı, ortak host collector yeniden kullanılır.
