# Install Deckent with an AI assistant

[Türkçe](ai-install.tr.md) · [README](../README.md) · [Known limits](https://github.com/Verhex/deckent-next/blob/main/docs/known-limits.md)

Use this guide when a person asks you to install Deckent. Ask for their target folder and the verified package artifact.
Deckent runs on the person's infrastructure; installation does not authorize their business operations.
This guide was written for alpha.56 and has not yet been re-checked against alpha.57 (uninstall v2). It is not a claim that an npm package or the website has been released.
For the last released version's source-install path, use the README.

## Prepare and install

Use Linux or WSL2 on x86_64. Native Windows is unsupported; macOS runtime support is incomplete.
The current package requires Node.js `>=24.22.1 <25 || >=26.12.1` and npm. Recheck the artifact's `package.json` engines
before installing; Node 25 is excluded. Docker must be installed, running and accessible for coding workers and image builds.
A local-model chat does not itself need a coding worker. Do not change OS permissions or install Docker with elevated privileges
without handing the administrator's step back to the person.

Deckent is not on npm yet. Obtain an artifact whose origin and integrity the person trusts. Replace the example tarball path
below with that artifact's absolute path; the filename is a placeholder. Do not guess an npm package name or download an
unverified substitute. Once an npm release exists, use its verified package identity and version.

```sh
npm install --global /absolute/path/to/deckent-package.tgz
```

Run the following in the person's chosen project folder, outside Deckent's source. Replace `my-project` with their stable
scope name. A scope groups policy and records; it is not a sandbox. This writes the fresh installation's language and
permissions; it does not choose an identity profile, sign in, enter a key or approve a card.

```sh
deckent init --yes --scope my-project --json
deckent doctor --json
```

Read the complete JSON and the process exit status. Installation completion is separate from onboarding completion.
Headless setup leaves authority pending; the first witnessed terminal open previews the profile and permission defaults for
the person. Do not report “ready” just because installation returned zero. Doctor can still report missing models, worker
configuration, warnings or unverified checks. It checks readiness; it does not install or start Docker.

## Hand these steps to the person

Ask the person to open `deckent` in that folder and complete the setup screens. Stop and hand back these steps:

- Sign in to their own provider or subscription account and accept any explicit consent for AI/background use. Never copy
  browser sessions or another user's credentials. Sign in with ChatGPT worker activation remains held pending N1 proof.
- Enter provider secrets in Deckent's masked field. Do not request the value in chat or put it in arguments, environment,
  logs, screenshots or your transcript.
- Review the profile, permission mode and permission/approval cards at their real terminal. AI, MCP, pipes and JSON do not
  witness a person's decision. Never simulate a terminal, alter policy files or swap commands to bypass a refusal.
- Decide any paid API budget. First-install budget is zero USD; no-spend paths are offered first. The API budget screen
  offers a 10 USD preset that the person can accept or change; do not accept it for them.
- Confirm uninstall, its tier, `--force`, `--disable-unit` and the backup passphrase themselves. Knowing the installation name
  grants no authority, and `--yes` does not replace the person at their terminal.

After their steps, run `deckent doctor --json` again and report the exact remaining failures and warnings. Report the scope,
package version supplied by the artifact, completed steps, person-only steps still pending and the next action. Doctor green
is installation evidence; it is not acceptance of a later ERP/CRM operation or a worker's output.

## Refusals and uncertain results

Keep each typed error `code` and its safe explanation/next action from the JSON; do not collapse it to “setup failed”.
A witness or policy refusal means the person must decide through the offered card. A missing connection, unknown tariff,
unavailable sandbox or unverified check means stop the dependent action and report the reason. Never paste raw secret-bearing
logs. After an interruption inspect the recorded result; an unknown effect is unresolved, not permission to retry it blindly.
Use the known limits page when the current build cannot provide the requested path.

## Uninstall

You may inspect the removal plan without applying it:

```sh
deckent uninstall --dry-run --json
```

The person runs `deckent uninstall` at a real terminal. A menu offers three tiers, each with a flag of its own; you may preview
any of them with `--dry-run` or `--json` (for example `deckent uninstall --all --dry-run --json`):

- `--keep-data` (default): caches go and the running service stops; work records, settings and history stay. The folder is
  retired: the next `deckent` there asks once whether to continue with the earlier data.
- `--keep-work`: also archives and deletes conversation data (history, logs, sessions, crash reports, previews; earlier backups stay); work records and
  pending work stay. Offered when there is pending work.
- `--all`: first a passphrase backup and an encrypted archive of every other file it deletes, both verified and kept in the
  person's private recovery folder outside every deleted folder; then the project's `.deckent`, `DECKENT.md` and the bridge line
  init wrote are deleted. Files the project's Git tracks and unknown files stay and are listed; a folder goes only when empty.
  `deckent backup restore` with that backup set brings everything back.

Every check runs before the one confirmation, and nothing is asked when there is nothing to remove. A refusal names its
cause and next step: running work (`--force` cancels it with the person's own authority and never closes an unknown result),
a service manager that restarts the service (`--disable-unit` separately approves disabling a user unit only when the manager
proves the exact fragment and link set and exclusive ledger custody fences startup; its unit file stays), queued deliveries
(`--all --force` withdraws through their queue owner after that owner authorizes each delivery before the card), policy,
retention or legal hold, or a moved or unsafe authority file. When Git tracking cannot be
read, every project file is treated as possibly tracked and kept.
`--yes` skips only the final card; the plan is still printed. Worker images stay; use only the exact command on the card.
macOS/Windows service removal is manual. A partial deletion resumes only after the remaining bytes and authority are verified again.

Read per-step results: interrupted, blocked or unknown is not complete. The output prints the program removal command when
the install method is proven (for example `npm uninstall -g deckent`), otherwise general guidance. Hand that final step to the
person; do not guess its package name or delete folders/images yourself.
