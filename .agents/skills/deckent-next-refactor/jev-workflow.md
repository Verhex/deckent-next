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
- `node .agents/refactor/jev-review.mjs report [COUNT]` reports the latest dated requests within a
  bounded scan, usage, latency, decisions, outcomes and Brier score only where evidence-backed labels
  exist. COUNT defaults to reportLimit (200); `report 100` selects 100. The scan defaults to 10,000
  directories (optional review config reportScanLimit). Scan truncation and undated requests are
  disclosed; global recency then remains unknown. Agreement is not correctness.

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

`prepare` now returns `diagnostics.sufficiencyRisks` (version 2, advisory-only). Warnings flag
empty option references, identical evidence sets/actions/impacts, locator-only observations,
checks citing only explicitly tagged `[plan]`/`[assumption]`/`[hypothesis]` (also `[varsayım]`/
`[hipotez]`), and lexical signs of missing measurements, balanced tradeoffs, rejected alternatives
or unknowns. Warnings describe review prompts, not semantic defects: common evidence may be valid,
a missing warning is not proof, and English/Turkish lexical hints can miss prose or flag valid text.
Do not add words or unrelated numbers merely to clear warnings. Empty/dangling check references
remain schema errors. Case schema v2, prepared questions and provider state are unchanged; warnings
stay in local diagnostics/journal and never become additional model context. No source retrieval,
auto-rewrite, automatic sanitization, retry, confidence score or acceptance is added.

### Host question hygiene and outcome evidence — owner accepted 2026-10-06

Current host `checks` always compile to Noul. Ask one explicit yes/no proposition per check;
name the option, field and observation being judged. For example, replace “Which option preserves
the boundary?” with “Does option A preserve the boundary observed in evidence X?” and an independent
check for B. A number cannot name an option or enumerate missing tests. Use the existing next_action
Choice for action selection; adding typed Choice/Score checks needs a separately defined host schema.
CHECK_NOT_BINARY and CHECK_MULTIPLE_QUESTIONS warn about leading open-question words (English/Turkish)
or multiple question marks. They are lexical prompts to inspect the question, not semantic validators
or automatic network gates. They preserve the authored payload. Do not merely reword to silence a warning.

All questions in a call are independent: a check cannot inspect the returned next_action or another
check's answer. Refer directly to the supplied option/evidence; combine outputs in code. Keep exact
counts, SHA equality, date ordering and passed/failed test checks in code; ask Jev for semantic evidence
fit. Preserve the exact north star, accepted decisions, contrary evidence and both abstentions.

After advice, record the actual actor choice with its rationale, including disagreement. On real
validation/closure, record verified/failed/inconclusive using a concrete evidence reference and an
observation of what happened. Leave the immutable outcome absent while still pending. Do not backfill
other sessions' records or infer success from agreement. Truth labels must address the exact proposition
in the exact request-time state: a later fix passing does not make an earlier missing-proof claim true.
Normative architecture preferences need an adjudicated acceptable option set, not an invented binary gold.

Report schemaVersion 3 exposes requestedAt, selectedProbability, separate confidence and sufficiency,
decisionRecorded/outcomeRecorded, labeledNoulAnswers and followUp coverage. Missing decision/outcome
records are visible gaps; they are not overdue/failure or evidence of omission rather than pending work.
Brier uses boolean labels on verified outcomes only; missing labels yield null, never fabricated accuracy.

Before claiming improved quality, freeze different evidence-backed cases and author labels before model
calls; keep development and validation sets separate and record label author/independence limits. A first
20-case pilot is not general calibration proof. Pin the observed model version only in evaluation config;
leave the ordinary provider configuration unchanged. Compare all attempts, failures, high-probability
wrong answers, abstentions, input tokens and p50/p95; measure operator effort separately when available.
Evaluate shorter authored observations against the same claim/options with the full charter preserved.
Perturb option ordering, missing evidence and adversarial data in explicit controls. No hidden retries,
training, threshold changes or automatic promotion from a pilot.

Verified official guidance (2026-10-06): https://docs.typesafe.ai/primitives/noul,
https://docs.typesafe.ai/patterns/fan-out, https://docs.typesafe.ai/models.
Research and accepted scope: external proof/JEV-USAGE-RESEARCH-2026-10-06/REPORT.md and
proof/JEV-HOST-HYGIENE-2026-10-06/. These are host-workflow rules, not a product dependency.
