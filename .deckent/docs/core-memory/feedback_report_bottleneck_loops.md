---
name: feedback-report-bottleneck-loops
description: Kısır-döngü/darboğaz ayarlarını (max_workers=1, tek-task sprint, erişilemeyen FIX) görür görmez Alperen'e proaktif bildir
metadata:
  type: feedback
---

Alperen (2026-08-17): "maxworker ayarı 1 yapılmış... 1-1 görevlerle dogfooding bitmez, bu gibi
kısır döngüleri bana bildirsene." Aynı gün örnekler: `max_workers=1` config'te kalmıştı;
tek/az-task'lı sprint'te NO_GO oran-eşiği (%50, `>=`) FIX bütçesine girmeden run'ı kesti
(540: 1/1; 541: 1/2); planner yeni-doğan dosya yollarını `filesWrite`'a koymayınca
attribution NO_GO döngüsü (540/542/543 — üç veri noktası).

**Why:** Bu sınıf ayar/etkileşimler tek başına zararsız görünür ama birleşince dogfood'u
yapısal kısır döngüye sokar; Alperen bunları ancak rapordan görebilir.

**How to apply:** Effective config/plan çözümlerken darboğaz sinyali gör (worker=1,
tek-task plan, FIX-erişilemez guard, tekrar eden attribution-hold) → işi durdurmadan İLK
raporda açıkça bildir; sessizce devam etme. Config'i kendiliğinden değiştirme — karar
Alperen'in (bkz. [[law-approval-gated-working-code]]).
