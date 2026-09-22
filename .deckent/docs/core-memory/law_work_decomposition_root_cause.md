# İş bölme ve kök neden

Arızanın nedeni, başarısız varsayım ve tekrarı önleyen mekanizma belirlenir; negatif kanıt eklenir. Değişmeyen hata kör retry ile tekrarlanmaz. Incident/closure paketi yalnız kendi closure'ını taşır; yeni ürün kazanımı ayrı kabul edilmiş outcome'dur (amend. 2026-08-17).

- İşler gerçek sorumluluk/dependency grafiğine bölünür; aynı kaynağa yazanlar serileştirilir. Task adedi ve paralellik instruction metninden değil effective config, DAG, collision/resource policy ve provider capacity'den çözülür. 3–5/8/20/40 sayıları tarihsel örnektir, minimum veya tavan değildir. Sabit sayı yerine mekanizma düzeltilir.
- Tek worker (`max_workers=1`), tek-task, erişilemez FIX veya attribution döngüsü throughput'u engelliyorsa kök neden ve etkisi görülür görülmez ownera raporlanır; düzeltme ölçülmüş kapasite ve bağımlılıkla yapılır. Yerel doğrulamanın iki fork sınırı ürün darboğazı sayılmaz.

Legacy dersler: tekrar eden sprint-fix döngüleri semptom yamalarının ve eksik kabul kanıtının sonucuydu; ağır task paketleri ve sabit 3–5 task planlayıcı throughput'u düşürdü.
