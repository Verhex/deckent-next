---
name: deckent-readonly-audit
description: Investigate a bounded Deckent Next repository, wiring, runtime or incident question through read-only evidence. Report coverage, findings and proof limits; do not implement fixes, run tests, admit work or change state.
---

# Deckent Next read-only audit

## Role and scope

Use `deckent-next-refactor` for the shared development method and a current
`deckent-authority-bootstrap` snapshot for authority, checkout, scope and work ownership.
Reuse unchanged session evidence; refresh affected sources when their context changes.
Bootstrap establishes the working context; this skill investigates the admitted audit question.

State the question, expected behavior or contract, exact revision and relevant dirty changes,
read boundaries and excluded actions. Distinguish an audit of an existing delivery from an
exploratory assessment with no admitted implementation task. Findings and recommendations
never create work, authorize fixes or constitute owner acceptance.

## Preserve the read-only boundary

- Inspect Next sources and retained evidence. Legacy `/home/alperen/deckent-dev` is a frozen
  read-only reference; never execute its runtime, workers, entry points or recovery procedures.
- Read tests as source, but do not run tests, builds, benchmarks, services, Deckent flows,
  migrations, cleanup or recovery. Do not edit code/documents/configuration, consume channel
  entries, merge, commit or push as part of an audit. Report necessary changes as recommendations.
- Use runtime queries or projections only when relevant and their side effects have been checked
  for the inspected revision. Names such as `status`, `help` and `list` do not establish safety.
  If safe inspection is unavailable, disclose the gap rather than execute an unproven command.
- Preserve concurrent WIP and its unknown ownership. Do not launch another agent automatically;
  delegation and an independent review assignment require their own authorization.
- Use sanitized projections and non-secret capability/auth/reachability metadata. Do not read
  raw product databases, credentials, tokens, private keys or secret-bearing files. Effective
  configuration, registry and capacity evidence govern claims; model-name prose is not routing authority.

## Follow the evidence chain

Inventory files and artifacts relevant to the question, then follow producer/consumer and
authority dependencies across the boundary as needed to resolve the claim. Inventory every
tracked file only for a repository-wide audit. Account separately for relevant untracked,
generated, runtime, large and binary artifacts; explain exclusions and remaining coverage.

Trace ingress/surface → application contract and transition owner → ports/adapters → producer,
durable state/receipt and consumer, including effective principal, scope and policy/configuration.
Use the actual chain for the feature; this notation does not impose a new architecture.
Inspect relevant failure, cancellation, replay, isolation and recovery paths as source/evidence.
Keep production wiring separate from declarations, tests, mocks, fixtures and planned behavior.

For each material claim distinguish:

- **Source evidence:** behavior is connected or missing at an exact code revision; tests were read.
- **Retained execution evidence:** a test, runtime or surface result was produced earlier, with
  its actual revision, environment, time, workload/scope and producer. It was not rerun in this audit.
- **Current observation:** safe inspection observed a specific process, event, receipt or surface;
  state what it proves and what remains unproven. Checkout HEAD alone is not the live code revision.
- **Unknown or uninspected:** identify missing evidence and the claim it prevents establishing.

Recheck important claims against another relevant source, such as the producer, consumer,
persisted receipt or actual entry wiring. Documents, projections and summaries that copy one
source are not independent corroboration. Your cross-check is not an independent reviewer PASS.
Generated exports and historical archives are evidence with provenance, never new authority.

## Findings and uncertainty

Describe capabilities as `çalışıyor`, `kısmen çalışıyor`, `yalnız görünüşte var`, `çalışmıyor` or
`kanıtlanamadı`, bound to the inspected revision, behavior and evidence level. `Çalışıyor` requires
matching execution/surface evidence; source wiring alone supports only a source-level conclusion.
Name the proved and unproved parts of partial behavior. Claim failure only with supporting evidence;
missing access, a missing observation or an unexecuted test is not proof of failure.

When an owner-admitted delivery is the reference, classify each finding as `BLOCKS_CURRENT_DONE`,
`RELATED_BUT_NONBLOCKING` or `UNRELATED` against that delivery's actual acceptance criteria.
Without such a delivery, group findings by their relation to the audit question and user impact;
do not invent a DONE gate or a new task to make the labels fit.

For contradictions name sources, identities/freshness and the applicable authority or canonical
producer evidence. Unresolved authority, attribution or freshness becomes a scoped report `HOLD`
with the dependent action and missing evidence/decision. It does not mutate product state or stop
unrelated authorized work. Absence of evidence is neither success nor failure.

## Required output

Lead with the conclusion in plain Turkish, then provide concise file/line or receipt evidence,
revision and observation time, coverage counts by relevant domain, skipped artifacts with reasons,
findings and user impact, contradictions/HOLDs and proof limits. Explain confidence from the
available evidence rather than inventing numerical scores. Keep raw logs and large code dumps out.
Separate verified facts, proposals, assumptions and unknowns; include contrary evidence.

Finish with the recommended next decision or evidence needed. A proposed test, fix or document
change remains a proposal; implementation, independent PASS, outcome closure and release are
separate authorized workflows. Do not manufacture a fresh test result or completion from this audit.
