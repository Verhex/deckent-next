# Cross-provider xverify netleştirme seçeneği

Codex/Brain, kök-neden veya tasarım kararı ciddi biçimde belirsiz kaldığında
`deckent xverify` üzerinden farklı provider ile bağımsız ikinci görüş alabilir.
Tercih edilen verifier Fable 5'tir; exact provider/model effective config,
registry, reachability ve entitlement evidence üzerinden çözülür.

Bu seçenek:

- otomatik karar veya kod değiştirme yetkisi vermez;
- ana agent'ın kanıt toplama ve kullanıcı onayı sorumluluğunu devretmez;
- same-provider self-verify'a düşmez;
- verifier authority doğrulanamıyorsa typed `unavailable/HOLD` olarak kalır.

Kaynak: Alperen onayı, 2026-07-30.

## §12.2 Fable→Sol production-verification closure (2026-08-13)

Netleştirme-seçeneğinden ayrı olarak, xverify bir **production doğrulama gate'i**
olarak da çalışır ve kapanışı tiptedir:

- Kapanış YALNIZ şu disk-receipt zinciri doğrulanınca gerçekleşir: gerçek terminal
  verdict + gerçek provider call + provider-reported usage + terminally-closed
  settlement + durable verdict receipt.
- Kanıtlanan koşu: author `claude / claude-fable-5` → verifier `codex / gpt-5.6-sol`,
  verdict **CONFIRMED / ALLOW**, assurance `typed-host-adjudicated`, provider-reported
  usage **total 60787** token, receipt
  `cross-verify-verdict:sha256:3543790980fdb345e65d065b011c877ecf728d53d4acab2d6bc7ef6d3426cf20`.
- Owner-bounded subscription adjudication: `execution_budget.purposes.xverify-adjudication`
  (maxTokens 100000, maxWallClockSeconds 300, maxVerificationsPerSprint 1); tavan aşımı
  verdict başarılı olsa bile typed overrun HOLD üretir; reserved/metered API yolu korunur.
- `HOLD`/`UNCLEAR` kapanış DEĞİLDİR; same-provider verify yasaktır.

Tam kayıt: `CLOSURE-OS-PRODUCT-TRANSITION-BRIEF.md` §12.2. Kaynak: Alperen onayı, 2026-08-13.
