# Provider-independent fallback execution-authority handoff (Alperen, 2026-08-21)

Provider limit/capacity, auth/reachability, context exhaustion, host failure,
owner-directed rotation veya başka typed decision blocker durumunda execution
continuity tek yön-spesifik dokümanla değil, iki tarafın da bütünüyle okuduğu
`fallback-rules/authority-handoff.md` ile yürür.

Target provider/model/host instruction metninden seçilmez; effective config,
registry, role policy, account/auth, reachability, usage/limit, finite-budget ve
capability evidence'ın kesişiminden çözülür. Configured tercih availability
iddiası değildir.

Authority dokümanı okumakla veya `PREPARED` görmekle geçmez. Normal cutover
append-only `PREPARED → VERIFIED → COMMITTED` receipt chain'iyle; transferor
unavailable ise yalnız explicit owner-authorized `RECOVERY_COMMITTED` ile olur.
Rollback state rewind değil, daha yüksek epoch'lu yeni handoff'tur. Transcript
authority değildir; owner message bus değildir; approval, destructive/external,
live-sprint, build/auth-mutation, secret ve cross-provider xverify sınırları aynen
korunur.

Bu manual disk-backed contract runtime fencing sevk edilmiş gibi sunulmaz.
Doküman bayatlarsa güncelleyen taraf Alperen'e tek satır rapor verir.

---
**Not (2026-09-20):** Bu kayıt [[feedback-worker-model-tier-routing]] ile bilerek ayrı tutuldu —
o model atama sıralamasıdır, bu ise engel anındaki **execution-authority devri protokolüdür**
(authority yalnız digest-chain'li `COMMITTED` veya owner-recovery transition'ıyla geçer; dokümanı
okumak devir değildir). Birleştirilmeleri iki kuralı bulanıklaştırırdı.
