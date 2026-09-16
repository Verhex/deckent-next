# Changelog

Human-curated. One line per landing, keyed by PLAN.md card id. No product code writes this file.

## Unreleased

- PLAN: Backlog section — 25 owner-admitted product outcomes triaged from the legacy MASTER-PLAN (286 candidates), with package/tier, dependency card and absorbed legacy ids.

- K1 REVISE: mask resolved config secrets in both CLI formats; recover stale writer locks with owner diagnostics and preserve live/foreign ownership; package-owned API auth validation, scoped cache inputs, stable doctor tenant view, injected state paths, and removal of unused orchestration validators.
- ARCH tiers gate: enforce tier direction, unit APIs and layout for kernel/providers/surfaces; register base defaults into core; move catalog and CLI entry paths; forbid provider credential env literals outside registry; build before real-binary tests in local/CI verification.

- K1: kernel config v2 with package-owned strict sections, safe migration/global writes, platform and tenant isolation, immutable localized error registry, shared output/exit policy; real CLI `config get`, `config migrate`, and kernel `doctor` wired for review.

- PLAN: K1/K2/R1 port cards written (Fable); W1 (win32 trusted loader authority) added; card location documented.

- K0: repository skeleton — package layout, `arch.json` contract, `lint-arch`, eslint size rules, build, CI, i18n kernel, CLI `--version`, first contract/e2e tests, harvested invariant catalog (`tests/contracts/HARVEST.json`, 40,828 titles from legacy HEAD 509fffa64).
