# N1 runtime under systemd (development host only)

The [deckent-n1.service](deckent-n1.service) template and [dev-release.mjs](dev-release.mjs) are maintainer host tooling, excluded from customer packages.
The maintainers keep the unit setup, switch, receipt and recovery steps of their own installation in a private record.
Customer installation, backup and recovery are described in [the installation guide](../../docs/ai-install.md), the [known limits](../../docs/known-limits.md) and the release entries in [CHANGELOG.md](../../CHANGELOG.md).

The template's placeholders are `@PROJECT@`, `@INSTALL_ROOT@`, `@NODE@` and `@LAUNCHER@`, each an absolute path of one installation.
The tooling accepts `Restart=on-failure` or `no` and refuses `always`; it never stops an unidentified ledger holder to make room.

Tests use temporary installations and a fake systemctl port; they never contact a real user
manager or live/N1 installation. Unit installation, systemd daemon behavior, hosted acceptance
and live health verification belong to the lead's separately authorized handoff.
