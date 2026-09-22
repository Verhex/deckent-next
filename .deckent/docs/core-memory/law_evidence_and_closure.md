# Kanıt ve kapanış

Kapanış gerçek kullanıcı/AI yüzeyi, çalışan binary ve kalıcı sonuç kanıtı gerektirir. Unit test yeşili, status/projection çıktısı, doküman, worker öz değerlendirmesi ve HOLD/UNCLEAR sonucu tek başına kapanış değildir. Her madde kendi kanıtıyla raporlanır; onaysız atlama ve erken zafer ilanı yasaktır (amend. 2026-08-17).

- Kullanıcıya yol göstermeden önce bilinen engeli söyle. Brain kabul, Auditor bağımsız denetim, Nervous gözlem sorumluluğudur; doküman tek başına çalışan Brain veya kabul kanıtlamaz. Ürün hedefiyle Next'te gerçekten bağlı mekanizmayı ayır.
- Canlılık ve ilerleme adapter custody, süreç/container kimliği, heartbeat zamanı, log ve result/settlement kayıtlarının birlikte incelenmesiyle doğrulanır. PID tek başına kimlik, heartbeat terminal başarı, log son satırı teslim kanıtı değildir. Eksik veya çelişkili kanıtta "bilinmiyor" de; varsayım etiketsiz söylenmez. `.hb/.log/.result` biçimi tek platforma zorunlu evrensel protokol değildir.
- Her iddiayı görülebilir davranış veya kaynakla eşle; nokta-iddiaya eşlik eden target gösterilir. Makinece denetlenebilir genellemeler gate ile doğrulanır. Büyük kanıt eksiksiz küçük kapsamların birleşimidir. Landing öncesi diff ve gerçek sonuçlar saklanır.
- Durable settlement, doğrulanmış custody, append-only audit ve gerçek effect kanıtı esastır. Foundation, ürün wiring ve kabul ayrı aşamalardır; projection gerçek durum authority'si değildir.

Legacy dersler:
- Status "writing" gösterirken worker yaklaşık dokuz dakika ölüydü → projection canlılık kanıtı değildir.
- 2026-08-17/18 UNCLEAR nedenleri: görüşü doğrulanabilir iddia sanmak, diff olmadan kod iddiası, excerpt'ten evrensel sonuç, birleşik kanıtın kesilmesi. Legacy xverify bayrakları Next çalışma emri değildir.
- Phase-4 foundation ve Phase-5 settlement kanıtları yalnız o revizyonları kapsar (genesis PR127/88637d5d6; ilk settlement dba89c03). Legacy rollout OPEN/DONE kayıtları Next durumunu veya iznini belirlemez; Next sözleşmeleri ayrıca kanıtlanır.
