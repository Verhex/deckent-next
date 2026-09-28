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
- Hedefli kanıt: tsc 0, lint-arch 0 ihlal, native 26/26 + yoklama 1/1, birleşme testleri 157/157.
- Sıradaki: tam verify (4 worker, Docker imajı) → Astra REQUEST_REVIEW → PASS'te tam sha push → canlı geçiş.

## Canlı geçişte yapılacaklar (PASS sonrası)
- Ledger v41 → v42 yedekli göç; layout 3 → 4 (`state/scratch`): geçişten önce kabul edilmiş Run'ların görevleri `RUN_STORE_CONFLICT`
  ile reddedilir (owner kabulü). Scratch sessizliği için canlı policy'ye `scratch_*` araç ve `workspace.scratch.write` operasyon izinleri
  (şablon ya da owner betiği); yoksa scratch çağrıları sorar. Ledger kilidi (`<ledger>-lock`) ilk başlangıçta oluşur.

## Açık kalanlar
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek (ayrı dilim); ret kodunda uç nokta/ledger ayrımı.
- Terminal hattı: fetch (S6, S7, S10) → sandbox (S9 bubblewrap — owner `bwrap` kurar — ve S11 Landlock); dilim 4d, `/compact`, satır modu, plan aracı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
