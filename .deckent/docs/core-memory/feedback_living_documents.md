---
name: feedback-living-documents
description: İki yaşayan kayıt — AI-Operatör Dersleri (docs/{tr,en}/playbook) her deneyimden sonra, göç dökümü (MIGRATION-LEDGER.md) her PASS/REVISE sonrası güncellenir
metadata:
  type: feedback
---

Aynı kuralın iki hedefi: *şu doküman yaşayan bir kayıttır, deneyim bitince güncellenir; unutulursa iş eksiktir.*
(Birleştirildi 2026-09-20: `feedback_ai_operator_lessons_doc` + `feedback_migration_ledger_and_support_mode`.)

## 1. AI-Operatör Dersleri (Alperen, 2026-08-18)

`docs/tr/playbook/ai-operator-lessons.md` + `docs/en/playbook/ai-operator-lessons.md` ikilisi, deckent'i AI
araçlarıyla süren kullanıcılara ve modellere öğretici YAŞAYAN dokümandır: kullanım hataları, dersler, hangi
özelliğin/aracın nasıl kullanılacağı.

**Why:** Kullanıcılar deckent'i AI ajanlarıyla sürecek; oturumlarda ödenen ders bedelleri dokümante edilmezse
her kullanıcı/model aynı hatayı yeniden öder.

**How to apply:** Her deneyimden SONRA yeni ders varsa **iki dile de** "Hata → Neden → Doğru kullanım"
kalıbında ekle; alttaki değişiklik günlüğüne tarihli satır yaz; iki dil senkron tutulur (aynı dosya adı, ayna
içerik). Landing zincirinin doküman adımının parçasıdır — unutulursa landing eksiktir.

## 2. Göç dökümü ve izleme günlüğü (Alperen, 2026-09-17)

Owner: "Ne taşındı, nereye taşındı, hangi şekilde; eskiden nasıldı, yeni projede nasıl; kalite skoru,
doğrulama, dogfooding akışına ve ürün yüzeyine katkısı/etkisi, pozitif/negatif sebepler, yavaşlatıcı etkiler —
tam detaylı analiz edilmiş bir log."

Uygulama: `/home/alperen/deckent-refactor-work/MIGRATION-LEDGER.md` (repo DIŞINDA; deckent-next markdown kapısı) —
**§1** kart bazlı tablo (legacy kaynak → hedef, dönüşüm türü KORU/BİRLEŞTİR/YENİDEN TASARLA/SİL/YENİ,
birleştirilen, doğrulama, Fable kararı + commit, skor T/K/P/D 0–5, dogfood/yüzey etkisi, riskler/yavaşlatıcılar),
**§2** sayılarla durum, **§3** kronolojik izleme günlüğü (kanal seq · UTC · olay · aksiyon · sonuç),
**§4** açık REVISE adayları. Her PASS/REVISE sonrası güncellenir.

**Why:** Owner kanal trafiğini okuyamaz; port kalitesini ve revise ihtiyacını **tek belgeden** görmek ister.

**How to apply:** İnceleme bitince tablo satırı + günlük satırı + §4 güncelle; Türkçe anlatım, EN teknik terim.
İlgili: [[law_turkish_and_ssot]], [[feedback_code_plus_business_summary]], [[feedback-xverify-claim-discipline]].

---
**⚠ Eskimiş referanslar (2026-09-20 ölçüldü, silinmedi):**
- Her iki playbook dosyası legacy'de **hâlâ var** (tr + en) — kural geçerli, kapsamı legacy.
- `MIGRATION-LEDGER.md` **var** (329.607 bayt) — kural geçerli.
- *"Fable sonsuz destek modundadır; Astra şeffaf durum bildirimi yapar"* — **taşıyıcısı kalmadı.**
  Koordinasyon kanalı 2026-09-20 20:00Z'de owner tarafından kapatıldı
  (`.agents/refactor/workspace.json enabled=false`; 348 kayıt `archive/communication-closed-2026-09-20-1dd9df0ca99e.md`
  içine arşivlendi, sha256 dosya adıyla doğrulandı). Kural yanlış değil, **uygulanamaz durumda**;
  yeni bir koordinasyon yolu açılırsa yeniden yürür.
