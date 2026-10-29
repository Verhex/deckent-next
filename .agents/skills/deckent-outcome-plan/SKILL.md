---
name: deckent-outcome-plan
description: Plan a Deckent Next package, wave, card or lane brief - one owner-admitted outcome as a bounded dependency DAG with ownership, law check, proof contract and owner question rounds, before implementation.
---

# Deckent Next Outcome Plan

## Scope and authority

Use `deckent-next-refactor` for the common development contract. Plan one exact owner-admitted
result using current ARCHITECTURE, PLAN, relevant core-memory and a current authority snapshot.
Reuse unchanged `deckent-authority-bootstrap` evidence; refresh only affected facts.
An accepted priority, audit, transcript or historical receipt cannot admit execution by itself.
This skill creates a plan, not a product Run, worker, state transition or new authority gate.
Product Brain (former brain rule, owner 2026-10-18) is a runtime role, not the host implementer.
Plan/evaluate against explicit acceptance; deterministic scheduling and authorization remain system responsibilities.

## Bound the result

- State the observable user/product result, current defect or gap, and acceptance boundary.
- Distinguish existing mechanisms from accepted future targets. Do not require dogfood or every
  product surface when the exact outcome does not claim them.
- Record exact read/write and negative scopes, concurrent ownership, protected paths, durable
  state, entrypoints, policy/config inputs, contract versions and migration dependencies.
- Map the actual application objects and transition owners. Inspect the Run/Task/Attempt and
  operation/effect chain in scope; do not impose an illustrative legacy hierarchy.
- Preserve installation/company/resource/principal boundaries and the standalone Core contract;
  Enterprise/ERP adapters extend registries and ports rather than introducing a second flow.
- For each person- or company-facing surface the outcome claims, write its journey spec (`deckent-beuser`)
  before implementation; the acceptance boundary is that journey, not the cards' own tests.

## Dependency and ownership DAG

For each node record its responsibility, prerequisites, exact inputs/outputs, sole writer,
write conflicts, verification and stop condition. A join accepts evidence from its own nodes.
Identify the critical path and genuinely independent lanes; do not create parallel agents
without authorization or when coordination costs outweigh the task.
Name shared hot files and assign one writer. Include affected document reconciliation.
A wide mechanical change (rename or retype across many call sites) is sequenced expand → migrate in batches →
contract: add the new form beside the old, move callers per package with each batch green, delete the old form last.
Resolve runtime provider/model/capacity from current typed config and policy only when runtime
execution is admitted; a host plan must not invent a worker or resource limit.

## Law check in every plan and lane brief

Every plan, card and lane brief carries the law check and two perspectives (full template:
`<refactor-work>/proof/LAW-GATE/CARD-TEMPLATE.md`):

    ## Kanun kontrolü (zorunlu)
    1. Kanıt ve kapanış — uyumlu / ilgisiz / çatışma: <neden>
    2. Yetki sınırı — uyumlu / ilgisiz / çatışma: <neden>
    3. Owner iletişimi — uyumlu / ilgisiz / çatışma: <neden>
    4. Doküman haritası — uyumlu / ilgisiz / çatışma: <neden>
    5. İş bölme ve kök neden — uyumlu / ilgisiz / çatışma: <neden>
    6. Model/provider tek kaynak — uyumlu / ilgisiz / çatışma: <neden>
    7. Yerel doğrulama — uyumlu / ilgisiz / çatışma: <neden>
    8. İkinci görüş — uyumlu / ilgisiz / çatışma: <neden>
    9. Alp Discipline — uyumlu / ilgisiz / çatışma: <neden>
    10. Enterprise katmanı — uyumlu / ilgisiz / çatışma: <neden>
    North star (güvenlik, determinizm, sınırlı kaynak, iptal/kurtarma, ölçülmüş performans) — <neden>
    ## İki bakış
    - Dogfood: Deckent kendini geliştirirken bu ne katar?
    - Hedef ürün: müşteri bir ERP/CRM sürecini yürütürken aynı mekanizma nasıl çalışır?
      Kod/test'e özgü bir öğe kalıyorsa git adapter'ında mı?

Before a material decision goes to the owner — a new package scope, an architecture or authority change,
or a law change — run the clean-context, read-only law auditor (`<refactor-work>/proof/LAW-GATE/AUDITOR-PROMPT.md`)
on the candidate and attach its PASS/HOLD table. Do not use it for small questions; Jev use is unchanged.

## Proof and bounded execution

Define producer → application → adapter → actual consumer proof, exact revision/input custody,
and relevant negative paths: denial, cancellation, replay, partial effect, timeout and recovery.
Separate source checks, author tests, retained execution, current surface evidence and independent
review. Mark unavailable platforms or consumers explicitly; tests alone cannot prove live behavior.
A claimed surface's proof contract names its BeUser walk: personas, installs, walkers and the assembled
release state it runs on after the narrow cards land (`deckent-beuser`).
Set finite time/cost/retry bounds from the actual task and current policy, changed-evidence
requirements, rollback or reconciliation path, stop conditions and escalation points.
For uncertain effects preserve `unknown` until reconciliation rather than promising a safe retry.

## Actions and output

Carry existing authorization forward. Identify only genuinely missing authority for destructive,
auth, live-intervention, commit or publish actions; planning does not grant it.
Use logged Jev for material tradeoffs, with realistic gains/losses and both abstention choices.
Owner questions go in rounds: hold the open decisions as a tree and ask the whole frontier (every decision whose
prerequisites are settled) at once, each with real options, gain/loss and a recommended answer that "evet"
accepts; find facts yourself and ask only decisions. The owner can run the full interview with `/deckent-grill`.
Return the outcome, DAG, ownership/scopes, contract/config dependencies, proof manifest,
budgets and stop rules, unresolved decisions and first admitted next step.
Do not start implementation or runtime merely because the plan is ready.
