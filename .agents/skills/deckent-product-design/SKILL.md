---
name: deckent-product-design
description: Use for Deckent product philosophy, personas, jobs, journeys, capability model, information architecture, progressive disclosure, or solo-to-enterprise complexity. Do not use for visual styling without a product-model question.
---


# Deckent Product Design

## Objective

Turn real Deckent capabilities into a coherent product model before arranging screens. The result
must work for a first solo run and for expert multi-project operation without becoming two
different products.

Load deckent-design-dna first.

Apply the current owner decision ratchet loaded by deckent-design-dna. Refine accepted product
semantics; do not restart direction exploration with rejected shells, modes or surface roles.

## Evidence to inspect

- Current identity and primary-surface authority
- The exact application service, protocol and state model in scope
- Implemented consumer paths and accepted Desktop/Terminal targets for the same job, separately
- Current terminology and i18n keys
- Relevant admitted workstream dependencies in PLAN and actual missing Next consumers

Do not infer a capability from a mockup, stale roadmap prose or an attractive component.

## Population matrix

Cover the relevant combinations:

| Dimension | Required range |
|---|---|
| Agency | guided, assisted, autonomous, supervised |
| Experience | first-run, occasional, expert operator |
| Organization | solo, team, regulated enterprise under the same company-scoped policy |
| Scale | one project/run, many projects, very large run history |
| Environment | local, remote, degraded, offline or reconnecting |
| Platform | macOS, Linux, Windows native, WSL |
| Language | English default, Turkish parity, expansion-safe layout |

Progressive disclosure may change density and available shortcuts. It must not hide authority,
cost, risk or irreversible consequences.

## Product modeling workflow

1. Define the user job and the decision the interface must support.
2. Identify the actual authoritative objects and their relationships. `do` may admit a Run
   independently of Mission; do not turn an illustrative object tree into a required hierarchy.
3. Map entry, success, failure, interruption, recovery and return paths.
4. Model the Golden Workflow first: conversation or command through run creation, execution,
   inspection, evidence and settlement.
5. Separate control, inspection, explanation and configuration.
6. Decide what belongs in Desktop, Terminal and Dashboard observability.
7. Define progressive complexity without duplicating the product model.
8. Validate nouns and actions against production code and i18n.

## Information architecture rules

- Organize around user intent and system state, not repository module names.
- A command and its result remain traceable as one causal chain.
- Current state, desired state and historical evidence are visually and verbally distinct.
- The primary action is unambiguous; dangerous actions expose scope and consequence.
- Empty states teach a valid next action without inventing sample activity.
- Dense enterprise lists provide search, filter, grouping, saved views and stable deep links when
  the underlying product supports them.
- Dashboard may summarize and link; it may not create a second command path.

## Required output

Produce a concise product contract containing:

- users and jobs;
- object and relationship model;
- Golden Workflow and critical variants;
- surface allocation;
- navigation and progressive-disclosure logic;
- permission, empty, stale, loading, failure and recovery states;
- unresolved product authority questions;
- acceptance evidence tied to real capabilities.

Do not proceed to visual polish while the product model contains contradictory ownership or
invented states.
