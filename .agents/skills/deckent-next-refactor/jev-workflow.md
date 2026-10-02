# Jev development decision support — owner 2026-09-19

Use Jev regularly for material development judgments: option tradeoffs, modularity/boundary reviews,
test coverage gaps, evidence/claim fit, and uncertain next actions. Deterministic checks still run directly;
do not call for every mechanical edit or repeat the same unchanged question to obtain a preferred answer.
Use the logged preparation layer from Next only (host tooling, not a product feature):
- `node .agents/refactor/jev-review.mjs prepare CASE.json` validates/compiles context offline.
- `node .agents/refactor/jev-review.mjs ask CASE.json` records request before the bounded external call.
- `node .agents/refactor/jev-review.mjs decision CALL_ID DECISION.json` records actor, selectedOption,
  rationale, actions and evidenceRefs; explicitly explain disagreement or missing evidence.
- `node .agents/refactor/jev-review.mjs outcome CALL_ID OUTCOME.json` records actor, status
  (verified/failed/inconclusive), observation, evidenceRefs, labels, inputQuality and outputQuality.
  Outcome is a final immutable assessment: leave absent while validation is pending. Noul labels require
  verified evidence and contain questionId, expected boolean, evidenceRef. Never label using Jev's own answer.
- `node .agents/refactor/jev-review.mjs report` reports bounded coverage, usage, latency, decisions,
  outcomes and Brier score only where evidence-backed labels exist; agreement is not correctness.

Case schema: schemaVersion=2, objective, scope, exact revision (identify dirty changes), constraints[],
unknowns[], evidence[{id,source,observedAt,observation}], options[{id,action,tradeoffs[],northStarImpact,evidenceIds[]}],
checks[{id,instructions,evidenceIds[]}], process{stage,currentState,acceptedDecisions[],nextStep,reopenReason}.
acceptedDecisions is nonempty; reopenReason is null unless proposing an amendment with its reason.
Tradeoffs name gains and losses; northStarImpact explains relevant quality dimensions and proof gaps.
Every preparation includes the exact curated `.deckent/docs/core-memory/project_product_north_star.md`
text and SHA-256 in state.northStar, with the authored case in state.case. This owner-authorized shared
context is mandatory; missing/invalid new case context fails before network. Historical journals remain readable. Use at least two meaningful options; separate facts from assumptions,
include contrary evidence and realistic tradeoffs. The compiler preserves authored options and always adds separate none_of_the_above (option set unsuitable) and insufficient_information (context inadequate) choices plus a
context-sufficiency question. Preparation checks structural coverage, not semantic perfection or truth.
Question/option identifiers must be unique; evidence references must resolve. Only authored sanitized context and that curated north star are sent; no other automatic source,
channel, customer data, credential or journal upload. Inspect the prepared state.

Settings: .agents/refactor/jev.config.json (provider), jev.review.config.json (context limits/templates/journal).
Overrides: DECKENT_JEV_CONFIG and DECKENT_JEV_REVIEW_CONFIG paths. Journal root resolves relative to review
config, defaults to Next .deckent/host/jev for both workspaces, private 0700/0600 and Git-ignored. Records are
immutable request/response-or-failure/decision/outcome files linked by callId; no auto-deletion/retention yet.
No recorded response after a crash means response-unknown, not failure or permission to repeat a billed call.
Credential: TYPESAFE_API_KEY, TYPESAFE_API_KEY_FILE, or configured ~/.config/typesafe/api-key reference.
Never print/source credentials or put them into state/commands/evidence. Private file storage is not a keyring.
One bounded call, no hidden retry; failure means unavailable advice. The low-level jev.mjs client is for
transport tests; normal development consultations use jev-review.mjs so preparation and journaling apply.

Jev is probabilistic advice, not proof, test success, independent PASS, policy, owner permission or acceptance.
Do not execute returned content or hardcode a universal confidence threshold. Record actual model/usage;
use independent tests/reviews to assess quality. No automatic training or behavioral promotion from this log.

Owner 2026-09-19: Jev choice consultations must always include both none_of_the_above and insufficient_information. Report their probabilities and selection counts separately; neither alone proves why the option space or context failed. Preserve historical defer records without relabeling. Review config schemaVersion=2; low-level transport remains generic, normal development consultations use the preparation layer.

### Context sufficiency preparation — owner 2026-09-28

For this development workflow, report selection probability against 0.90 and context sufficiency
against 0.75; aim for at least 0.85 sufficiency on the first well-prepared call. These are owner
review criteria, not automatic tool gates or evidence of decision correctness. Never repeat an
unchanged question to chase a score. Preserve option meaning in context-only comparisons.

Before asking: pin the decision-time revision and scope; state accepted decisions and why any
reopening is justified; distinguish observed facts, proposals, assumptions and unknowns. Supply
short sanitized observations/excerpts, including contrary evidence, not only source paths (Jev
cannot open them). Explain how each observation distinguishes the actions; connect each check
to the specific supporting evidence and state unproven paths. For each option write concrete
Gain/Loss (Kazanım/Kayıp), north-star impact and remaining proof gaps. Describe rejected alternatives
and their reasons in existing process/constraints/evidence fields; if none apply, say so without
inventing them. For speed/cost/scale claims supply measurements with workload, environment and
revision, or explicitly mark a hypothesis. Do not turn a planned test into a passed test.

`prepare` now returns `diagnostics.sufficiencyRisks` (version 1, advisory-only). Warnings flag
empty option references, identical evidence sets/actions/impacts, locator-only observations,
checks citing only explicitly tagged `[plan]`/`[assumption]`/`[hypothesis]` (also `[varsayım]`/
`[hipotez]`), and lexical signs of missing measurements, balanced tradeoffs, rejected alternatives
or unknowns. Warnings describe review prompts, not semantic defects: common evidence may be valid,
a missing warning is not proof, and English/Turkish lexical hints can miss prose or flag valid text.
Do not add words or unrelated numbers merely to clear warnings. Empty/dangling check references
remain schema errors. Case schema v2, prepared questions and provider state are unchanged; warnings
stay in local diagnostics/journal and never become additional model context. No source retrieval,
auto-rewrite, automatic sanitization, retry, confidence score or acceptance is added.
