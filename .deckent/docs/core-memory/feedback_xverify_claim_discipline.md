---
name: feedback-xverify-claim-discipline
description: XVerify claim'i ekli kanıttan yerel-karar-verilebilir nokta-iddia olmalı; verify COMMIT'ten ÖNCE --diff'le koşulur
metadata:
  type: feedback
---

2026-08-17 canlı kanal onarımı sonrası dört Sol koşumu dürüst UNCLEAR verdi ve hepsi
claim/kanıt-yazım hatasıydı: (1) A/B **görüş sorusu** — xverify karar vermez (kanun 14);
(2) `--target` yolları `filesChanged` sayılınca salt-analiz claim'inin evidence-map'i
bozuldu (B6); (3) "hiçbir yerde / tüm string'ler" gibi **evrensel** önermeler excerpt'ten
karar verilemez; (4) landed commit SONRASI `--files`'lı kod-claim'i "changed-without-diff"
sayıldı — working-tree diff boş olduğundan `--diff` kanıt lane'i kapalıydı (receipt
`…e66a3619`).

**Why:** Verifier yalnız ekli host-bound kanıttan hüküm kurar; kapsam = kanıtın kapsamı.

**How to apply:** (a) XVerify'ı **commit'ten ÖNCE** koş: `--files` + `--diff` birlikte —
verify→land sırası. (b) Claim = ekli aralıkta GÖRÜNEN somut yapı/davranış nokta-iddiası;
her iddiaya onu gösteren `--target` eşlik eder. (c) Evrenseller (0-hardcode, tam i18n,
tek-importer) makine-gate'lere (lint/grep/test) kanıtlatılır, xverify'a sorulmaz.
(d) Salt-analiz claim'ine dosya listesi ekleme. Bkz [[feedback-xverify-clarification-option]].


## Ek (2026-08-18 — evidence-read tavanı keşfi)

Haftalık UNCLEAR sınıfının kökü kanıtlandı: hakemin TEK birleşik kanıt-okuması vardır
ve büyük dosya setinde TRUNCATE olur ("the sole permitted combined evidence read was
truncated"). Kural: **koşu başına küçük kanıt seti** — tek küçük dosya veya yalnız dar
`--target` excerpt'leri; çok-dosyalı kompozit iddia verme, iddiayı koşulara böl.
Kanıt: CONFIRMED receipt `…57448f5a` (tek-dosya koşusu) vs truncation-UNCLEAR
`…48b9be1a`/`…e191d331` (8-dosya ve 3-dosya koşuları). Kalıcı çözüm (ranged/multi-read)
7081-residual'dadır.

## Owner konumlandırması (Alperen, 2026-08-18): verify GENİŞ ve KANIT'tır

Dar-kanıt kuralı bir GEÇİCİ çözümdür, hedef daralması değildir. Verify'ın konumu:
**geniş kapsam + kanıt-pozisyonu** — landing'in tüm kritik iddiaları doğrulanır ve her
receipt MASTER evidence'ına işlenir. Genişlik, tek dev koşuyla değil (truncation),
BİRDEN ÇOK dar koşunun KOMPOZİSYONUYLA sağlanır: iddia seti koşulara bölünür, her koşu
CONFIRMED/receipt üretir, toplamı landing'in geniş doğrulamasıdır. Kalıcı çözüm
(ranged/multi-read evidence access, 7081-residual) öncelikli işlerdendir — indiğinde
tek koşuda geniş verify normalleşir.

---
**Çapraz atıf:** Bu kayıt claim **disiplinidir**; ne zaman ikinci görüş alınacağı ve production kapanış
tipi Kanun 14'tedir ([[feedback_xverify_clarification_option]]). İkisi ayrı dosyadır çünkü ikincisi kanundur.
