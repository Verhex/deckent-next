# N1 runtime under systemd (development host only)

Use the [deckent-n1.service](deckent-n1.service) template for an owner-admitted N1 installation.
It is host tooling, excluded from customer packages. Replace `@PROJECT@`, `@INSTALL_ROOT@`,
`@NODE@` and `@LAUNCHER@` with absolute paths for that installation; `@LAUNCHER@` must be its
`.agents/refactor/next-entry.mjs`. The unit's working directory owns configuration/data;
its launcher resolves the staged `current` pointer. Set the same `DECKENT_NEXT_INSTALL_ROOT`
when invoking [dev-release.mjs](dev-release.mjs). Quote/escape paths according to systemd's
unit-file syntax; the custody validator currently accepts space-free launcher and environment paths.

For authorized unit installation, place the rendered file at
`~/.config/systemd/user/deckent-n1.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now deckent-n1.service
systemctl --user show deckent-n1.service --property=MainPID,WorkingDirectory,ControlGroup,UMask,Restart
journalctl --user -u deckent-n1.service
```

The unit explicitly sets `UMask=0022`. Product-owned private files/directories still use their
own 0600/0700 modes. Keep `Restart=on-failure` (or `no`): `always` would race the successful
governed shutdown with an automatic restart and is refused before the switch stops anything.

Before an admitted switch, retain a verified product backup. Stage reviewed code, then invoke
the existing `dev-release.mjs switch <id>` flow. It discovers the actual running process using
its own CLI, even when the staged client cannot see the previous release's socket path.
The migration fallback binds OS UID, installation working directory, ledger-lock inode and
exclusive kernel custody, plus the descriptor's process ID. An unidentified ledger holder
refuses the switch; the tool never kills it to make room.

For a process in `deckent-n1.service`, the tool checks the unit's working directory, launcher,
install-root environment, mask, restart policy and cgroup/MainPID binding. The previous service
must first accept governed `runtime shutdown` with its exact instance and a fresh command ID;
its process and ledger custody must end before the pointer moves. The replacement starts with
`systemctl --user restart deckent-n1.service`, followed by runtime describe/build verification.
No raw spawn substitutes for a failed systemd command. Rollback and failure recovery keep
systemd ownership; a private, installation-scoped `service-unit.json` hint lets `start` recover
an already-known managed installation while the unit is down, with fresh unit validation.
For a newly installed but never-observed inactive unit, use its authorized systemd start first.
Do not delete the hint to force a raw start; an invalid/stale unit definition is a refusal.

Inspect the switch JSON and `switches.jsonl` for the shutdown command ID, actual old CLI,
`serviceManager`, old/new build and ledger versions. Systemd captures runtime output in the
journal; host logs record the restart command result. A systemd ledger upgrade's pre-upgrade
backup remains under the installation's product backup directory; rollback finds it there
when no journal event was retained in the host log. Newer-ledger rollback still needs the
existing loss report and confirmation token. After switching, verify health and build on the
real admitted N1 surface; temporary fixture checks do not prove live acceptance.

Tests use temporary installations and a fake systemctl port; they never contact a real user
manager or live/N1 installation. Unit installation, systemd daemon behavior, hosted acceptance
and live health verification belong to the lead's separately authorized handoff.
