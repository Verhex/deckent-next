# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-28, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `dd63fd9` (beşinci parti). Canlı servis `dd63fd9` build'iyle (instance `5c266b90…`, ledger v42, layout 4; kanıt
  `proof/LIVE-SWITCH-BATCH5-2026-09-28`). Önceki canlı: (instance `46d6473f…`), ledger v41, protokol v16 penceresi
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
- Tam verify `dd63fd9` exit 0 (403/2669, native 26+1, host 62, smoke); Astra 2152 PASS @dd63fd9; `origin/main` = `dd63fd9` (push 2026-09-28).
- Canlı geçiş yapıldı (owner onayı): workline turu çalışıyor; açık bulgu: satır modu `terminal session` `MODEL_INVOCATION_RESULT_LIMIT`.

## Altıncı parti (`integrate/2026-09-28-g`, worktree `/home/alperen/deckent-next-integrate-g`, taban dd63fd9)
- Fetch birleşti (`lane/fetch` `e6bc551`; S6/S7/S10; Q1 Jev ee030c0e: `allowlist` katı, `approval` kart; `deposit` 2149 yazım şeridinde, eşzamanlı
  deposit regresyonu tabanda 3/3 kırmızı → yeşil).
- Sandbox birleşti (`lane/bwrap` `7e1281e` ⊃ `lane/landlock`): S9 bubblewrap → S11 Landlock → host (prefer notu) / ret (require); `sandbox: kısmi`
  etiketi bağlandı. arch delta'lar uygulandı (lint-arch 0), composition 4912/5000.
- Tam verify 646065c exit 0 (409/2731). Astra 2154 REVISE: bwrap R1 toolchain kardeş bağı HOME'a, R2 hard link takma adı, R3 okunamayan/derin
  dizin maskesiz → `lane/bwrap` `985d82a` birleşti (canonical bind, nlink>1 maskesi, eksik tarama tmpfs/ret; bwrap ~145 ms/çağrı).
- Astra 2156 REVISE: R2 sınıfı Git özel yollarında (korunan inode'a hard link `.git` dosyası / `.git/` içi takma ad iki realm'de okunuyor,
  bwrap'ta yazılıyor) → `lane/bwrap` `dd36e3d` birleşti (inode tabanı Git grant'lerinden önce ve tüm Git metadata'sına; doğrulanmış nesne muafiyeti;
  bwrap ~178 ms, Landlock ~124 ms/çağrı).
- Astra 2158 REVISE (entry 2157 incelemesi; notları ana checkout PLAN/current-flow WIP'inde, yedek `.deckent/host/reviews/astra-main-notes-2026-09-28-2158.patch`):
  R1 dizin önbelleği çocuk nlink/içerik değişimini görmüyordu (sıcak çağrı korunan yeni içeriği okudu), R2 nesne önbelleği anahtarında ctime/kimlik yoktu →
  `lane/bwrap` `4fdd645` birleşti: hüküm her çağrıda (`lstat`), yalnız hash önbelleği (anahtar dev/ino/size/mtime/ctime/beklenen kimlik). Bedel: bu depoda bwrap
  ~420 ms, Landlock ~310 ms/çağrı (hızlandırma ayrı dilim).
- TERM-FEEDBACK-1 birleşti (`ab8baf0` özetleme, `50bca7e` ürün durumu ajana/sandbox'a kapalı — bwrap'ta runtime soketine bağlanma açığını da kapatır, `946464b`
  sistem istemi v4); Astra'ya ek bulgu olarak bildirildi (2160).
- Sıradaki: tam verify → Astra yeniden inceleme → PASS'te push → canlı geçiş (owner onayı; `service.responseMaxBytes` 4 MiB + policy v2 şablonu ile).
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
