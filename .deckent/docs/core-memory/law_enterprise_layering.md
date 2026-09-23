# Enterprise katmanı ve ERP adapter ailesi

Owner kararı 2026-09-23 (Jev 124d141b two_lanes_contract_gate 0,99): Deckent'in ticari hedefi Deckent-Enterprise'dır. Core açık kaynak (MIT) ve bağımsızdır; bilinirlik ve kullanıcı kazanımı içindir. Enterprise, Core'un yayımlanmış sözleşmelerinin üzerine giydirilir. Core, Enterprise'ın Core'u değiştirmeden takılamayacağı bir sözleşmeyle genişletilmez.

- Her Core sözleşmesi (etki, onay, kimlik/scope, registry, ledger, yüzey) şu soruyla tasarlanır: bir ERP operasyonu ve ayrı dağıtılan bir Enterprise paketi bunu Core'u düzenlemeden yeniden kullanabilir mi? Hayırsa önce genel sözleşme düzeltilir.
- Sözleşme kapısı: modüle özel yeni niyet → talep → etki → kapanış akışı yazılmaz. Dış etkiler tek genel etki sözleşmesinden geçer (sürümlü operasyon, koşullu yazma ön koşulu, idempotency, operasyon düzeyi onay, belirsiz etki uzlaştırması, telafi). Git teslim/benimseme bu sözleşmenin bir adapter'ıdır.
- ERP'de commit yoktur: karşılığı katalogdaki sürümlü iş operasyonudur; kayıt sürümü/iş koşuluyla koşullu yazma, ERP tarafında idempotency anahtarı, dört-göz/görev ayrılığı onayı, uzlaştırma ve rollback yerine telafi (iptal/ters kayıt).
- ERP adapter ailesi Enterprise'dadır: IFS, SAP, Oracle, Microsoft, Uyumsoft, Logo. Her biri aynı Core operasyon/etki/onay sözleşmesini uygular. Müşteriye özel ERP geliştirme projeleri bu adapter'larla yapılır; müşterinin ERP sürüm güncellemelerine göre iç paketlerin yazımı ve dağıtımı Deckent-Enterprise'ın sorumluluğudur. ERP sürümü adapter ve paket sürümüne açıkça bağlanır; sessiz uyumluluk varsayılmaz.
- Enterprise paketleri Core'u fork etmeden adapter, politika, kimlik sağlayıcı (IdP), migration ve yüzeyi registry üzerinden kaydeder; yayımlanmış Core kaynak/geçmiş/paketlerinde yer almaz. Core Enterprise olmadan kurulur ve güvenlidir.
- Yürütme iki hattadır: dogfood hattı (zaman kutulu, yeni etki türü yok) ve Enterprise'ı taşıyacak Core hattı. İlerleme dogfood ve Enterprise/ERP hazırlığıyla raporlanır; tek bir yoldaki cilalama başarı ölçütü değildir.

Ders (2026-09-23): 09-22 "Enterprise yüzeyleri acil değil" kararı, Enterprise'ı taşıyacak Core sözleşmelerinin de bekleyebileceği şeklinde uygulandı; sonuç beş ayrı el yazımı etki akışı, yalnız Task'a bağlı onay ve registry'siz Core oldu. Yüzeyler bekleyebilir, taşıyıcı sözleşmeler bekleyemez.
