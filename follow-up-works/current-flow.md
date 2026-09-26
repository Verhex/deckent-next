# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-26 akşam, Opus 5.5)

Bu belge yalnız güncel durumu tutar; geçmiş bölümler `deckent-refactor-work/archive/current-flow-2026-09-26-before-reset.md`,
durum raporu `deckent-refactor-work/STATUS-REFAKTOR-DURUM-2026-09-26.md` ve `proof/` dizinlerinde.

## Durum
- origin/main `5fa0812` (owner izniyle push, 2026-09-26; tam verify `f7a9631`'de exit 0: 332 dosya / 2.169 test, native 25, host 55, smoke).
- Yerelde push sonrası: `6786bc2` owner kararları (belge), `2900a8d` Astra 2106 düzeltmesi, `b92d906` cli bölünmesi (W0-7), belge paketi.
- Canlı servis v13'te (eski build). Canlı yeniden başlatma + `grant-edit-shell.mjs` owner kararıyla **Astra PASS sonrası**.
- DOGFOOD OFF.
- Kota (2026-09-26 19:12Z): Codex haftalık %0 (pencere bugün 21:06+03'te sıfırlandı, sonraki 2026-10-03 21:06+03; kaynak son
  `rate_limits`, `~/.codex/sessions/2026/09/26/rollout-…15-20-56….jsonl`); Claude `/usage` ve Cursor panosu **owner'dan bekleniyor**.

## Paralel şeritler (owner 2026-09-26; lead Opus, kartlar `deckent-refactor-work/cards/lanes/`)
- L1 2091, L2 2094, L3 cli bölünmesi, L6 belge paketi bu oturumda zaten yapıldı (Astra 2107, 2100, 2108 kuyruğunda) — şerit açılmadı.
- L4 H34 tenant→company **açılmadı** (Jev `8215548c` defer 0,71; PLAN "Önemli açık bulgular"); yerine L4C Cursor salt-okunur dilim 4
  tasarım notu (`proof/L4C-SLICE4-DESIGN-2026-09-27/design-note.md`, effort `F26-t-l4-slice4-design-2026-09-27`).
- L5 I40 kök neden: Codex, `lane/l5-i40` @ `/home/alperen/deckent-next-lane-l5-i40` (taban `eb29ccc`), yalnız 5 test dosyası;
  effort `I40-l5-root-cause-2026-09-27`; kanıt `proof/L5-I40-2026-09-27/` (lead taban koşumu 46/46, 197 s).
- Codex sandbox reçetesi (kanıtlı): `-s workspace-write -c sandbox_workspace_write.network_access=true --add-dir <ana>/.git
  --add-dir <ana>/node_modules --add-dir <proof>` (vitest `.vite-temp` sembolik bağlı `node_modules`'a yazar; Docker çalışıyor).
- L5 teslim: `b0487e2` (yalnız tanı; 2 test dosyası), kök neden ürün zaman sözleşmesi (PLAN I40) → owner checkpoint. Codex 21 dk.
- L4C teslim: tasarım notu + lead kabul notu; 7 soru Jev'e soruldu (`proof/L4C-SLICE4-DESIGN-2026-09-27/jev-decision-packet.md`); q5 owner kararı.
- Açık Claude şeritleri (2026-09-26 ~19:40Z): H34 company tasarımı (Fable), C12 genel + A04 tasarımı (Opus), D03 MCP idempotentHint
  (Sonnet, Agent worktree — taban 5fa0812 geldi, kartta 362047b yazıyordu; server.ts arada değişmedi). Entegrasyon dalı `integrate/2026-09-27` @ 362047b.
- 2026-09-26 gece: H34 tasarım notu (Fable) ve C12+A04 tasarım notu (Opus) teslim, lead kabul notlarıyla (`proof/H34-COMPANY-DESIGN-2026-09-27/`,
  `proof/C12-A04-DESIGN-2026-09-27/`); açık sorular owner checkpoint'inde. H34 notu gerçek negatif vaka buldu: `scopes: 'all'` grant'ı uydurma
  scopeId'yi üye sayıyor (kapsam varlık kaydı yok).
- D03 MCP: ilk teslim `b9fd7d4` kartın hatalı "yıkıcı ⇒ false" kuralını uyguladı; lead düzeltmesi (Jev `749dbd33` evidence_table 0,92) ile
  Sonnet şeridi r2'de; 4 yıkıcı araç replay kanıtıyla true, 6 test dosyası kapsamda.
- I40 ürün düzeltmesi (owner kararı, Jev `4dbd0c32`): Opus şeridi `lane/i40-time-contract` @ `/home/alperen/deckent-next-lane-i40-time`
  (taban d525eeb + tanı `3ea79c8`); kart `cards/lanes/I40-time-contract.md`.
- Dilim 4 q5 owner kararı: modun gevşettiği kararlar tam denetim kaydı, zaten sessizler özet sayaç (Jev `dd82e3ed` decision yazıldı).
- Entegrasyon `integrate/2026-09-27` @ `2d06c56` (worktree `/home/alperen/deckent-next-integrate`): D03 + I40 (+ L5 tanı) + arch + belgeler.
  Tam verify `verify-2.log` exit 0: native 25, vitest 334 / 2.210, host 55, smoke (ilk koşu yalnız `FORCE_COLOR=3` yüzünden 2 test; PLAN bulgusu).
  REQUEST_REVIEW **2109** gönderildi (2100–2108 ile birlikte bekliyor). Push: Astra PASS + owner izni → yalnız incelenen sha.
- 2026-09-27: Astra 2110–2113 **REVISE** (2100 dosya yazımı abort kaydı P2; 2101 kabuk yolu symlink+`..` onaysız dış okuma **P1**;
  2102 host-shell normal çıkışta arka plan çocuğu + baş/kuyruk UTF-8 P2×2; 2103 `run_shell` etki kimliği turlar arası P2) — gövdeler
  `.deckent/host/reviews/astra-2110-2113/`, tüketildi. Düzeltme şeritleri: FIX-RA (Opus, 2111+2113) `lane/fix-ra`, FIX-RB (Fable, 2112+2100)
  `lane/fix-rb`. 2104/2105/2107/2108/2109 bekliyor. Canlı etkinleştirme ve push bu düzeltmeler + PASS sonrası.
- Owner M1 Hat B kararları (PLAN); Jev r2 (kararlar + gerekçe): 15/15 owner seçimi birinci, 11'inde p ≥ 0,90, ama yeterlilik 0,47–0,71 < 0,85 →
  owner kuralına göre ağırlıksız (`proof/OWNER-DECISIONS-2026-09-27/jev-r2-results.md`).
- Açık şeritler: H34 S1 (Opus, `lane/h34-s1`, ledger v39), I40-b (Codex, `lane/i40b`), A04-1 (Fable, `lane/a04-1`), FIX-RA, FIX-RB.
  C12 Q8 tipli ret S1 sonrası (`src/engine/core/policy/**` çakışması). Ledger sırası H34 v39, C12 v40.
- L7 dogfood harnessi: başlamadı (L5 test koşarken Docker çakışması riski; tam verify saatinin dışında).

## Owner kararları 2026-09-26 (PLAN "Önemli açık bulgular" başında)
- Ajan yazımı yalıtımı (2094 R2): belgelenmiş son kontrol–rename yarışı kabul; native/Landlock yazıcı yok.
- Uzun istek (2106 R2): serviste pay (yanıt × 4 bayt + girdi payı), istemci ön denetimi, tipli ret; protokol değişmez.
- Dilim 4 izin modu: policy katmanında (kişi başına overlay, şirket policy'si 'mod-uygun' işaretlemedikçe etkisiz) — Cursor devri.
- Canlı etkinleştirme: Astra PASS sonrası.

## Astra inceleme sırası (hiçbiri tüketilmedi; son Astra yanıtı 2106, 18:11Z)
`2100` 2094 dosya yazımı · `2101` 3a sınıflandırıcı · `2102` 3b yürütme · `2103` 3c-i `run_shell` · `2104` 3c-ii canlı çıktı ·
`2105` 3c-iii temizleme · `2107` 2106 düzeltmesi. Kanal 2011 (Fable'a) dokunulmaz.

## Sıradaki adımlar (Fable durum analizi sırası, owner 2026-09-26)
1. Belge paketinin kalanı: README yüzey iddiaları (HTTP API yok, Docker var, terminal), ARCHITECTURE "Package contract" eski paket adları,
   core-memory `MEMORY.md:6` sayısı — ayrı küçük belge dilimi.
2. Astra PASS'leri (2100–2107) → REVISE gelirse önce düzeltme → owner push izni → yalnız incelenen sha.
3. Canlı: build + governed yeniden başlatma (ledger v37→v38 yedekli) + `! node /home/alperen/deckent-refactor-work/proof/F26-T-L4-LIVE-GRANTS-2026-09-26/grant-edit-shell.mjs`;
   owner senaryosu (hata bul → diff onayı → testi kabukta koştur → sonucu oku).
4. Cursor devir prompt'u hazır: `deckent-refactor-work/CURSOR-TERMINAL-SLICE4-T-L5-PROMPT-2026-09-26.md` (dilim 4 policy katmanında izin modları
   + T-L5 kalanı; başlama koşulu: Astra PASS + push edilmiş taban; `/compact` sürüm artışı ister → sözleşme kararı).
5. Opus ana hatta: M1 Hat B (C12 genel, A04, H34, IFS tasarımı, FOUNDATION registry) — owner ile ayrı checkpoint.

## Açık sınırlar (bu oturumda kaydedilen, ARCHITECTURE'da)
- Ajan yazımı: son kontrol–rename arası aynı kullanıcı yarışı (kabul edildi); başka yazar version kontrolü–rename arası.
- Kabuk: sandbox değil; dolaşma/git nesne okumaları `low` → sorar; servis çökerse çalışan komut sahipsiz kalır; PowerShell yok (Windows her komutta sorar).
- T-L5: `compacted` olayı tek çerçeveye sığmazsa tur iptal; eşiğin üstünde kalan kuyruk her turda yeniden özetlenir.
- Temizleyici: işçi transkripti ve hata bildirimleri kapsam dışı.

## Kanıt dizinleri (`deckent-refactor-work/proof/`)
`F26-T-L4A-FIX-2092` (mutasyon 1–7, verify-a4604fc) · `F26-T-L5-FIX-2091` · `F26-T-L5-FIX-2106` · `F26-T-L4B-FIX-2094` ·
`F26-T-L4C-SHELL-3A` · `F26-T-L4C-SHELL-3B` · `F26-T-L4C-SHELL-3C` (+ verify-f7a9631) · `F26-T-L4C-SHELL-3C-II` · `F26-T-L4C-SHELL-3C-III` ·
`F26-T-L4-LIVE-GRANTS-2026-09-26` (owner betiği).

## Jev kayıtları
Bu oturum: 46cfa6c6 (2092), 4a702440 (2091), 3d6703e5 (2094), d6909e28 (3a), 52f9b6f9 (3b), 82858581 (3c-i) — karar + sonuç yazıldı.
Fable analizi: q1, q2, q4, q7, q10 verified; q3, q5, c331f6af inconclusive (owner push sırası / sıra değişti); q6 (Cursor devri),
q8 (2094, Astra 2100), q9 (2091, Astra 2107) doğrulama bitince yazılacak.
