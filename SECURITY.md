# Security policy

## Supported versions

Security fixes target `main` and the current `1.0.0-alpha.N` pre-release line (currently
`1.0.0-alpha.3`; see [CHANGELOG.md](CHANGELOG.md)). Older alpha snapshots are not maintained
separately; reproduce against current main/current alpha when possible. Pre-release support
does not imply production or platform acceptance.

## Reporting a vulnerability privately

If GitHub private vulnerability reporting is enabled for this repository, use **Security →
Report a vulnerability** at [the repository's security page](https://github.com/Verhex/deckent-next/security).
Availability has not been verified by this documentation change; SECURITY.md alone does not enable it.

If that option is unavailable, use the maintainer's private contact:
**[OWNER TO FILL: monitored private security email or reporting URL]**.
This is a placeholder, not a working endpoint. The owner must fill it or enable and verify GitHub
private vulnerability reporting before relying on this policy as an operational reporting route.
Until a private route is available, ask `@AlbSar` for one without disclosing vulnerability details.
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
