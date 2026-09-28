# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-28, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `4346081` (Astra 2145 düzeltmeleri). Canlı servis bu build'le (instance `46d6473f…`), ledger v41, protokol v16 penceresi
  [16, 15], layout registry 3. Qwen3.8 bağlaması v5 (`chat-template-enable-thinking`) canlıda etkin. Canlı policy v1 (herkes `ask`). DOGFOOD OFF.
- Ana checkout'ta Astra/owner WIP'i (core-memory `MEMORY.md`, `law_local_verification.md`, manifest, `hemen-donulecek-is.md`) korunuyor;
  canlı geçişte stash/yama ile saklanır, atılmaz.

## Beşinci parti (`integrate/2026-09-28-f`, worktree `/home/alperen/deckent-next-integrate-f`)
- İçerik: B06-2b (ledger v42 benimseme intent v2 + v1→v2 göçü), B09-2 (yapılandırılmış worker raporu), B06-2c (doğrulama önkoşulu,
  CLI, salt-okunur bağımlılık bind'i), TERM-PICKERS, S5 (`terminal.shell.realm` + yetenek yoklaması), SCR-A (scratch alanı, layout 4,
  `/scratch`, sistem istemi v2), SCR-B (`init policy` ilk çalıştırma şablonu), COMP-BUDGET-2 (composition 4826/5000), Astra Jev bağlam
  kalitesi uyarı denetimi (host tooling), LEDGER-SINGLETON (ledger başına tek servis), main `4346081` birleşmesi.
- Birleştirmede lead düzeltmeleri: şablon araç/operasyon adları gerçek kataloğa sözleşme testiyle bağlandı (ters kanıt: ad bozulunca
  kırmızı); Astra 2145 iki-soket testi artık ikinci servisin `LOCAL_RUNTIME_ALREADY_RUNNING` ile reddini bekliyor; S5 native yoklamasının
  manifestine test betiği eklendi (`test:native` onu reddediyordu → tam verify düşerdi).
- Tam verify `599a0fc` exit 0 (402/2659, native 26+1, host 62, smoke). Astra 2149 REVISE: R1 temizlik ↔ yeni tur yarışı, R2 eşzamanlı yazımda
  kota aşımı → `lane/fix-2149` `deb2b7d` birleşti (tur açmadan önce tutar, temizlik silme boyunca sahip, kapanış drain; tek yazım sırası).
- Sıradaki: bu düzeltmeyle tam verify → Astra yeniden inceleme → PASS'te tam sha push → canlı geçiş.

## Altıncı parti adayları
- Fetch `lane/fetch` `453f1d7` (S6/S7/S10; Q1 Jev ee030c0e ile karar: `allowlist` katı, `approval` kart). Birleşmede `deposit` fix-2149'un
  `spend` yazım sırasına bağlanır (`proof/FIX-2149-2026-09-28/docs-delta.md` §2) + eşzamanlı deposit regresyonu.
- Dogfood: ölçüm `proof/DOGFOOD-MEASURE-2026-09-28` (test imajında git/openssl/python3/cc yok; `--configLoader native` salt-okunur
  bind'i çözer); bağımlılıklı doğrulama imajı Cursor şeridinde (`proof/DOGFOOD-IMAGE-2026-09-28`); tek komut döngü seçenekleri A/B/C.

## Canlı geçişte yapılacaklar (PASS sonrası)
- Ledger v41 → v42 yedekli göç; layout 3 → 4 (`state/scratch`): geçişten önce kabul edilmiş Run'ların görevleri `RUN_STORE_CONFLICT`
  ile reddedilir (owner kabulü). Scratch sessizliği için canlı policy'ye `scratch_*` araç ve `workspace.scratch.write` operasyon izinleri
  (şablon ya da owner betiği); yoksa scratch çağrıları sorar. Ledger kilidi (`<ledger>-lock`) ilk başlangıçta oluşur.

## Açık kalanlar
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek (ayrı dilim); ret kodunda uç nokta/ledger ayrımı.
- Terminal hattı: fetch (S6, S7, S10) → sandbox (S9 bubblewrap — owner `bwrap` kurar — ve S11 Landlock); dilim 4d, `/compact`, satır modu, plan aracı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
