---
name: deckent-design-critic
description: Use for assigned evidence-backed Deckent design review across product, interaction, visual, component, accessibility and enterprise surfaces. Independent verdicts require a separate reviewer; implementer self-review reports findings.
---


# Deckent Design Critic

## Role

Follow the actual assigned review role. An independent verdict requires a reviewer other than
the implementing session, an exact candidate revision/diff and fresh scoped evidence. A second
pass by the implementer is self-review and cannot be labeled independent PASS. This skill does
not authorize spawning agents. Review-only scope does not authorize fixes or document mutation.
Name whether the artifact is a specification, prototype or implemented surface; verdict coverage
must match that artifact and cannot promote prototype approval to production completion.

Load deckent-design-dna, then only the domain skills relevant to the review.

## Required inputs

Inspect:

- accepted product and visual authority;
- real implementation or prototype artifact;
- exact states and data sources represented;
- screenshots or terminal captures at representative conditions;
- interaction, accessibility and test evidence;
- known foundation dependencies and ownership boundaries.

If real evidence is required but absent, do not guess PASS.

## Review rubric

1. Product truth: no invented capability, state, metric or authority.
2. Agentic semantics: causality, ownership, lifecycle, freshness, evidence and recovery are clear.
3. Information hierarchy: the primary decision and next safe action are obvious.
4. Visual language: accepted Graphite/Desktop and inherited Terminal rules, with restrained tone.
5. Interaction: keyboard, focus, streaming, interruption and destructive actions are coherent.
6. Accessibility: WCAG 2.2 criteria and applicable ARIA patterns, zoom, reduced motion, forced
   colors and non-color carriers.
7. Enterprise: scope, permissions, policy, audit, cost and company/resource isolation where relevant.
8. Cross-surface parity: shared semantics with surface-appropriate adaptation.
9. i18n and platforms: real strings, expansion, macOS/Linux/Windows/WSL behavior.
10. Implementation feasibility: existing architecture, performance, migration and wiring closure.
11. Evidence: real rendered behavior, not code intent or mock-only claims.

## Finding format

Each finding must contain:

- ID and severity: BLOCKER, HIGH, MEDIUM or LOW
- Surface, workflow and exact state
- Evidence: file, screenshot, capture, behavior or missing proof
- Violated contract
- User or operational impact
- Smallest durable remedy
- Verification required to close it

Avoid taste-only language such as feels off. State the observable problem and consequence.

## Verdict rules

PASS:

- no BLOCKER or HIGH finding;
- critical states and target environments have credible evidence;
- no false production-complete claim;
- any lower findings are explicitly non-blocking.

REVISE:

- direction is viable but one or more material problems must be corrected before acceptance.

NO-GO:

- product truth is false;
- authority or tenant boundaries are unsafe;
- core workflow or recovery is missing;
- design contradicts accepted direction;
- accessibility blocks the primary job;
- implementation depends on nonexistent wiring;
- evidence is too incomplete to evaluate a critical claim.

## Output

Return:

    ROLE: assigned independent reviewer | implementer self-review
    CANDIDATE: exact revision/diff and artifact kind
    VERDICT: PASS | REVISE | NO-GO (self-review uses findings, without independent PASS)
    SCOPE: reviewed surfaces, states and evidence
    FINDINGS: ordered by severity
    EVIDENCE GAPS: explicit missing proof
    ACCEPTED STRENGTHS: only evidence-backed strengths
    CLOSURE: exact checks required for the next verdict

Do not dilute a blocking finding with a numeric score.
