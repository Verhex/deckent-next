# Anlık iş akışı — devir, sıradaki adım, kanıt (2026-09-29, Opus 5.5 lead)

Bu belge yalnız güncel durumu tutar; önceki sürümü Git geçmişinde, kanıtlar `deckent-refactor-work/proof/`.

## Durum
- `origin/main` = `0e0ca63` (altıncı parti; Astra 2167 PASS, kanal REVIEW 2168). Canlı servis `0e0ca63` build'iyle (instance `f810508e…`, owner onayı
  "Şimdi geç"; kanıt `proof/LIVE-SWITCH-BATCH5-2026-09-28/BATCH6-README.md`), ledger v42, `service.responseMaxBytes` 4 MiB → satır modu yanıt veriyor;
  canlı policy v2. Geri dönüş: `dd63fd9` build'i + `config-before-batch6.json`. DOGFOOD OFF.
- Canlı geçişte görülen küçük bulgular: bwrap içinde `ls .deckent/live-data/state` giriş adlarını listeliyor (içerik maskeli, ad düzeyinde meta veri);
  terminal kapanınca onay bekleyen tur onay TTL'i (9 dk) dolana kadar `running` kalıyor.
- Ana checkout `dd63fd9` + `0e0ca63` ff; Astra/owner WIP'i (core-memory, `hemen-donulecek-is.md`, `auto-edit-test.txt`) korunuyor; Astra 2167 notları
  yamada (`.deckent/host/reviews/astra-main-notes-2026-09-29-live6.patch`) ve aşağıya işlendi.

## Astra 2167/2168 (2026-09-29)
- Aday `0e0ca63`: kapsamlı olmayan bağımsız **PASS** (2166 wildcard ürün yolu kapandı: desteklenmeyen etkili yol typed admission reddi; normal/bracket/brace
  desteği korunuyor). İzole build + native, lint-arch 0, 95/95 hedefli test; gerçek servis başlangıcı ve iki realm'de onaylı tur kanıtı. Opus tam verify logu
  okundu (412/2763, exit 0; bağımsız tekrar yok). Kanıt `proof/ASTRA-2167-2026-09-29/review.md`; Jev 540a8645 PASS 0,99, yeterlilik 0,79 (tavsiye).
- Takip: `model-invocation-process` geçici 45 s sınırı yedinci partide kaldırıldı (`3bb8058`, STARTUP-COST sonrası ≈24 s ölçüldü) — tam verify ile
  doğrulanacak; `LAYOUT_*` typed kodlarının i18n metni küçük takip.

## Yedinci parti (`integrate/2026-09-28-h`, worktree `/home/alperen/deckent-next-integrate-h`, taban `5b267a9` + main `0e0ca63`)
- Birleşenler (her biri `--no-ff`):
  - SESSION-RESULT-LIMIT `c67302c` (doctor `modelInvocationDelivery`, `MODEL_ACTIVATION_DELIVERY_UNFIT`).
  - POLICY-ADMIN P1–P3 `6e76c42` → POLICY-HARDEN P3-R `3e01b90` (yetki onayı yalnız yetki yüzeyinde `APPROVAL_SURFACE_RESTRICTED`, settle anında ret,
    `authority-refusal` audit, redakte kart farkı).
  - MCP-CLIENT `4cc7ca0` → `afb7518` (kapsamlı kayıt dosyaları, `mcp.clients` config'ten kalktı) → `db5121d` (add = güven, ilk kullanım kartı, `/mcp`).
  - MCP SDK 2.2.0 + sayfalı araç listesi `d934c5b`; STARTUP-COST `3f879c6` (Ink ve MCP server SDK statik grafikten çıktı).
  - MODE-UX G3 `fd3c5e4`; PERSISTENT-APPROVALS G6 `d389bee` (kapsam seçmeli kalıcı onay; tel v17 ve servis kablosu açık).
  - SANDBOX-SPEED G2 `1ed884d`; TERM-UX-1 `3dbbed7`; ANTHROPIC-PROVIDER G8 `50d86ce` (checkpoint A/B açık).
- **Birleştirilmedi: SHELL-AUTONOMY `e627273`** — PERSISTENT-APPROVALS ile aynı yetki fonksiyonunu farklı değiştiriyor (`decideAgentToolCall`: kalıcı onay
  adımı ↔ sandbox hücre gevşetmesi; `mode.ts` `decide()` imzası ve `run(inner, ownerApproved)`), birleşik davranış için test yok. Lead kararı bekliyor;
  realm dosyalarının çözümü hazır (şerit + SANDBOX-SPEED `fs-ops` birlikte).
- Lead düzeltmeleri: MCP client SDK'sı tembel yükleniyor (`e7d6553`); 0e0ca63 ↔ MCP kayıt dosyası ajan deny listesi (ürün durumu deny'ı + `.deckent/mcp.json`);
  `surfaces/core/terminal` birim bütçesi (2000) aşımı iki bağımlılıksız parçanın taşınmasıyla çözüldü (kart tuş eşlemesi → `terminal-kit`, `ArrowPicker` →
  `terminal-render`); deny eşleyicisi hızlı yolu platformun tek `GLOB_WILDCARD` tanımını kullanıyor; `APPROVAL_SURFACE_RESTRICTED` ve MCP güven/`/mcp`,
  TERM-UX-1 metinleri en/tr + kayıt; MCP güven deposu okunamazsa typed hata.
- Composition 5202/5500; lint-arch 0.
- Sıradaki: lead SHELL-AUTONOMY kararı → tam verify (lead) → Astra incelemesi → PASS'te push → canlı geçiş (owner onayı).

## Açık kalanlar
- Owner tasarım onayları (2026-09-29): soru kartları A, terminalden Agent OS O1, DECKENT.md Öneri 1 — uygulama dilimleri bu partiden sonra (owner: yeni iş yok).
- SHELL-AUTONOMY açık owner soruları: C1 program tabanı sandbox'ta, C2 audit event v2 (realm/hücre), C3 `unrestricted` modu (bindings v3), C4 onaylı çağrıda
  taban yazılabilir; `run_shell` model açıklaması sürümü.
- LEDGER-SINGLETON: model sahip kimliğindeki `custodyId`'yi ledger custody'sinden türetmek; ret kodunda uç nokta/ledger ayrımı.
- Dogfood hattı: canlı execution/adoption profili ve doğrulama config'i; Deckent verify'ının sandbox'ta ölçümü; tek komut döngü; operatör aktivasyonu.
- Temizlik komut listesi (owner çalıştırır): `proof/INTEGRATE-2026-09-27/cleanup-commands.md` + biten şeritler, stash'ler.
