# Security policy

## Supported versions

Security fixes target `main` and the current `1.0.0-alpha.N` pre-release line (currently
`1.0.0-alpha.32`; see [CHANGELOG.md](CHANGELOG.md)). Older alpha snapshots are not maintained
separately; reproduce against current main/current alpha when possible. Pre-release support
does not imply production or platform acceptance.

## Reporting a vulnerability privately

Report vulnerabilities privately through GitHub private vulnerability reporting: **Security →
Report a vulnerability** on [the repository's security page](https://github.com/Verhex/deckent-next/security),
or directly at [the private advisory form](https://github.com/Verhex/deckent-next/security/advisories/new).
This is the only reporting channel (owner decision 2026-10-03); reports reach the maintainers privately.
Do not post exploits, secrets, customer data or identifying reports in public issues/PRs.

Include the affected version/commit, Core component, reproduction steps or a minimal proof of concept,
expected/observed behavior and impact. Share sensitive material only through the confirmed private
channel. Coordinate disclosure with the maintainer; no response or fix-time SLA is claimed here.

## Scope

This policy covers the open-source **Core** in this repository: authorization/policy and approval
boundaries, filesystem/process/network/secret isolation, runtime/worker execution, patch and artifact
custody, data integrity, installation, dependencies and public SDK/CLI/MCP surfaces.
Proprietary Enterprise is distributed separately and needs its own reporting/support policy.
Third-party provider/platform issues should also reach their vendor through its private channel.

Test only systems you own or are authorized to test. Use a minimal reproduction and redact secrets.
Security concerns take the private route even when a bug report template would otherwise fit.

## Local identity and approval boundary

The local runtime verifies the OS UID through kernel socket credentials. `deckent-mcp` has a separate
`<host>/mcp` actor; owner grants and all-principal allow rules do not delegate to it. Model/spend
mutations need explicit grants naming that actor. Tool annotations are advisory, never authorization.
Human approval allow/deny requires the peer's controlling terminal and matching interactive stdin/stdout;
piped or redirected decisions refuse without settlement. Hard-floor allow also requires the initiating
turn's process-bound capability. This attests terminal interaction, not human presence: a process under
the same OS account can allocate a PTY or access the owner's files/socket directly. Protect separate
trust domains with OS identities and enforced sandbox boundaries; no same-account process isolation
or automation approval exception is claimed by this change.

## Policy administration continuity

All product authority writes share one locked writer. A change that removes the last usable named
administrator in any previously administered scope is rejected with `POLICY_LAST_ADMIN`: add another
administrator first. Capability requires `policy.administer/execute` and approval `inspect/decide`,
with denies, restrictions, separation of duties and available decision assurance applied. MCP actors
never count as administrators; a permission mode grants no administration authority. Final and
crash-visible intermediate snapshots are checked before the publication audit and file replacements.

`deckent policy status --scope <id>` (also SDK `inspectPolicyAdministration` and MCP
`inspect_policy_administration`) observes the same scoped policy snapshot without repairing it.
Doctor shows one readiness line. Counts describe policy capability, not verified external directory
activity, human presence or OS custody. Bootstrap and custody transfer remain separate work.
Current-template rollback requires a complete bounded authority archive chain and removes only
current-version additions whose content has never changed; custom rules remain in `conflicts`.
Missing, corrupt or oversized history refuses rollback. Archives retain existing local-owner custody
and are not a cryptographic provenance guarantee against that host owner.
