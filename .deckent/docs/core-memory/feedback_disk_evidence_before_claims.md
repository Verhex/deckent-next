---
name: disk-evidence-before-claims
description: Canlılık/ilerleme iddiası ASLA status-projection'dan yapılmaz — önce disk kanıtı (hb mtime, kill-0, log tail, result); varsayım etiketlenmeden söylenmez
metadata:
  type: feedback
---

Sprint-507 gecesi (2026-08-11): `deckent status` "Writing code" gösterirken worker'lar
9+ dakikadır ölüydü (son hb 00:41, runner PID 55905 dahil hepsi dead), fix-worker hiç
doğmamıştı. Asistan status çıktısına dayanarak "retry'lar kod yazıyor" raporladı —
Alperen: "uydurma ve varsayımlar kabul edilmeyecektir; bilgiler ve beklentiler tamamen
yanlış ve uydurma."

**Why:** deckent'in status/read-model projection'ları henüz güvenilir değil (status-projection
dürüstlüğü MASTER-PLAN'da açık iş ailesi — RECOVERY-BORN-488-STATUS-PROJECTION-001 vd.).
Projection'a dayalı iddia = sentetik verdict kabulü; CONFIG-RESOLVED SUPERVISION bunu
zaten yasaklıyor. Yanlış iyimser rapor, owner'ın gece kararlarını bozuyor.

**How to apply:** Bir koşu/worker hakkında "canlı / ilerliyor / doğdu / bitti" demeden önce
ZORUNLU disk doğrulaması: (1) `.tasks/*.hb` mtime'ı şimdiye karşı, (2) PID dosyası +
`kill -0`, (3) worker log tail'inin son timestamp'i, (4) `.result` varlığı/içeriği.
Projection yalnız yön gösterir, kanıt sayılmaz. Doğrulanamayan her şey rapora
"doğrulanmadı" etiketiyle girer; beklenti ile gözlem aynı cümlede karışmaz.
[[law_proof_blockers_brain_eval]] [[law_alp_discipline_anchor]]
