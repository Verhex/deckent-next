# deckent — host pointer
Read ARCHITECTURE.md (package contract + decision log) and PLAN.md (port ledger) before any change.
Rules: file ≤800 lines · packages import only via index.ts · no hardcoded user strings/model ids · no new .md files.
Gate before landing: `npm run verify`. Roles: Astra implements, Fable analyses/reviews. Owner: Alperen.
