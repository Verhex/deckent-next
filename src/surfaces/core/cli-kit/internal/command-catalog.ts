import type { MessageKey } from '#platform/index.js';

export const HELP_GROUPS = ['start', 'observe', 'work', 'models', 'approvals', 'setup', 'developer'] as const;
export type HelpGroup = typeof HELP_GROUPS[number];
/**
 * How a command relates to the dispatcher's installation identity preflight (ID-1C relocation stop). Absent: the dispatcher reads the
 * installation identity before the command runs. `owned`: the command loads, heals or recovers the installation and checks its identity
 * itself (config; init apply/resume/policy read it under the installation journal). `independent`: the command needs no installation or
 * project at all. Actions inherit their family's value unless they declare their own.
 */
export type CliInstallationContract = 'owned' | 'independent';
/**
 * What a family does when no action is given (owner 2026-10-19 "boş komut yok"). `handler`: the family handler already acts on its own
 * (opens a view, lists, or runs its single purpose). `read`: the named read-only action runs once every `requires` flag is present.
 * Otherwise the dispatcher lists the actions and names the missing argument (`requires`, else `<action>`) and exits 2. A default never
 * mutates state: only an action that reads may be named here.
 */
export type CliBareBehaviour = 'handler' | { readonly read?: string; readonly requires?: readonly string[] };
export interface CliCommandSpec { readonly name: string; readonly group: HelpGroup; readonly summary: MessageKey; readonly detail: MessageKey;
  readonly installation?: CliInstallationContract; readonly children?: readonly CliCommandSpec[];
  /** Family synopsis for the main help, CLI syntax only: flags verbatim, `<placeholder>` words localized through `cli.help.placeholder.*`. */
  readonly args?: string; readonly bare?: CliBareBehaviour;
  /** Named and reserved from the owner review for a later slice; not registered, not shown; its handler refuses it like any unknown action. */
  readonly planned?: true;
  /**
   * The arguments an action never runs without, in CLI syntax: a flag with its value (`--input <file|->`), a positional (`<name>`) or
   * alternatives (`--input <file|-> | --schema`). Help shows them; when the handler refuses the call as a usage error and one is absent, the
   * refusal names it (CLI_ARGUMENT_MISSING, exit 2). The handler keeps every check and a person's terminal picker. `--scope` is never listed:
   * its default and refusal belong to the scope rule (CLI_SCOPE_REQUIRED).
   */
  readonly requires?: readonly string[];
  /** A person on a real terminal picks or fills what `requires` lists (the handler's picker or form); help says the list holds off a terminal. */
  readonly picks?: true | readonly string[] }

function action(name: string, group: HelpGroup, summary: MessageKey, detail: MessageKey,
  more: Pick<CliCommandSpec, 'installation' | 'requires' | 'picks'> = {}): CliCommandSpec {
  return { name, group, summary, detail, ...more };
}
const INPUT = ['--input <file|-> | --schema'], RUN_CHANGE = ['--id <id>', '--command-id <id>', '--expected-revision <n>'];
const MODEL = ['--provider <id>', '--provider-version <n>', '--model <id>', '--model-version <n>'], TASK = ['--run <id>', '--task <id>'], ATTEMPT = ['--attempt <id>', '--layout-revision <id>', '--generation <n>'];
const MODEL_CHANGE = [...MODEL, '--command-id <id>', '--expected-revision <n>', '--binding-digest <sha256>'];
const CATALOG_CHANGE = ['--channel <id>', '--command-id <id>', '--expected-revision <n>'];
// J2e: no reserved (planned) name is left after `run list` (C-RUN) and `policy scopes` (C-APPROVE); a later reservation adds
// `{ …, planned: true }` again and the grouped-help test names it.

/** The dispatch catalog: the one inventory of commands, actions, help and bare behaviour (help = behaviour, owner 2026-10-19).
 * Register a command here with its group, localized summary and detail; the main help shows every entry (no hidden or `--all` tier).
 * Children inherit the family handler; existing handlers retain argument validation and execution. Handler actions and catalog
 * actions are kept equal by `cli-grouped-help.test.ts` (both directions). */
export const CLI_CATALOG = [
  { name: 'uninstall', group: 'setup', summary: 'cli.uninstall.help.summary', detail: 'cli.uninstall.help', installation: 'owned', args: '[--keep-data|--keep-work|--all] [--force] [--disable-unit] [--yes] [--dry-run [--verbose]] [--json]', bare: 'handler' },
  { name: 'hub', group: 'work', summary: 'hub.help.summary', detail: 'hub.help', args: '[--scope <id>] [--input <file|->]', children: [
    { name: 'sources', group: 'work', summary: 'hub.help.action.sources', detail: 'hub.help', bare: 'handler', children: ['list', 'add', 'remove'].map(name => action(name, 'work', `hub.help.action.sources.${name}` as MessageKey, 'hub.help')) },
    ...['search', 'inspect', 'install', 'update', 'uninstall', 'verify', 'export', 'refresh', 'cards', 'publish', 'yank', 'revoke'].map(name => action(name, 'work', `hub.help.action.${name}` as MessageKey, 'hub.help')),
  ] },
  { name: 'report' , group: 'observe', summary: 'resource.cost.help.summary', detail: 'resource.cost.help', args: '[--scope <id>] [--run <id>] [--verbose]',
    bare: 'handler' },
  { name: 'do', group: 'work', summary: 'cli.help.summary.do', detail: 'cli.help.do', args: '--request <text> [--scope <id>]', bare: { requires: ['--request <text>'] } },
  { name: 'audit', group: 'setup', summary: 'cli.audit.summary', detail: 'cli.audit.help', args: '[--scope <id>]', bare: { read: 'verify' }, children: [
    action('verify', 'setup', 'cli.audit.summary', 'cli.audit.help'),
    action('rebaseline', 'setup', 'cli.audit.rebaseline.summary', 'cli.audit.help', { requires: ['--reason <text>'] }),
  ] },
  { name: 'backup', group: 'setup', summary: 'cli.help.summary.backup', detail: 'cli.help.backup', installation: 'owned', args: '[<action> --scope <id> --set <path>]', bare: 'handler', children: [
    action('create', 'setup', 'cli.help.action.backup.create', 'cli.help.backup'),
    action('verify', 'setup', 'cli.help.action.backup.verify', 'cli.help.backup'),
    action('restore', 'setup', 'cli.help.action.backup.restore', 'cli.help.backup'),
  ] },
  { name: 'terminal', group: 'start', summary: 'cli.help.summary.terminal', detail: 'cli.help.terminal', args: '[--scope <id>] [--full-access]', bare: 'handler', children: [
    action('workline', 'start', 'cli.help.action.workline', 'cli.help.terminal'),
    action('session', 'start', 'cli.help.action.session', 'cli.help.terminal'),
    action('status', 'start', 'cli.help.action.terminal.status', 'cli.help.terminal'),
    action('chat-plan', 'start', 'cli.help.action.chat-plan', 'cli.help.terminal'),
    action('snapshot', 'start', 'cli.help.action.snapshot', 'cli.help.terminal'),
  ] },
  { name: 'init', group: 'start', summary: 'cli.help.summary.init', detail: 'cli.help.initPreview', installation: 'owned', args: '[--json] [--yes --scope <id>] [--preview] [--profile <file>]', bare: 'handler', children: [
    action('preview', 'start', 'cli.help.action.preview', 'cli.help.initPreview'),
    action('inspect', 'start', 'cli.help.action.init.inspect', 'cli.help.initPreview'),
    action('apply', 'start', 'cli.help.action.apply', 'cli.help.initPreview'),
    action('resume', 'start', 'cli.help.action.init.resume', 'cli.help.initPreview'),
    action('identity', 'start', 'cli.help.action.identity', 'cli.help.identity'),
    action('policy', 'start', 'cli.help.action.policy', 'cli.help.initPreview', { requires: ['--preview | --apply'] }),
    action('pool', 'start', 'cli.help.action.init.pool', 'cli.help.initPreview'),
    action('registry', 'start', 'cli.help.action.init.registry', 'cli.init.registry.help', { requires: ['--provider <id>', '--kind <kind>', '--pool <id>', '--execution-slots <n>', '--in-flight-slots <n>',
      '--discovery repository|disabled', '--preview | --apply'] }),
  ] },
  { name: 'monitor', group: 'observe', summary: 'cli.help.summary.monitor', detail: 'cli.monitor.help', args: '[--once|--json] [--scope <id>]' },
  { name: 'workers', group: 'observe', summary: 'cli.help.summary.workers', detail: 'cli.workers.help', args: '[--scope <id>] [--all | --since <12h>] [--verbose] [--limit <n>]',
    bare: { read: 'list' }, children: [
    action('list', 'observe', 'cli.help.action.workers.list', 'cli.workers.help'),
    action('watch', 'observe', 'cli.help.action.watch', 'cli.workers.help'),
  ] },
  { name: 'run', group: 'work', summary: 'cli.help.summary.run', detail: 'cli.help.run', args: '[--scope <id>] [--id <id>]', children: [
    action('list', 'observe', 'cli.help.action.run.list', 'cli.help.run'),
    action('create', 'work', 'cli.help.action.create', 'cli.help.run', { requires: ['--id <id>', '--command-id <id>', '--graph <file|->'] }),
    action('propose', 'work', 'cli.help.action.propose', 'cli.help.run', { requires: ['--proposal <file|->'] }),
    action('inspect-proposal', 'observe', 'cli.help.action.inspectProposal', 'cli.help.run', { requires: ['--id <id>', '--command-id <id>'] }),
    action('reserve', 'work', 'cli.help.action.reserve', 'cli.help.run', { requires: RUN_CHANGE }),
    action('inspect', 'work', 'cli.help.action.run.inspect', 'cli.help.run', { requires: ['--id <id>'], picks: true }),
    action('cancel', 'work', 'cli.help.action.run.cancel', 'cli.help.run', { requires: RUN_CHANGE, picks: true }),
    action('close', 'work', 'cli.help.action.close', 'cli.help.run', { requires: RUN_CHANGE, picks: true }),
    action('hold', 'work', 'cli.help.action.run.hold', 'cli.help.run', { requires: [...RUN_CHANGE, '--reason <text>'], picks: true }),
    action('resume', 'work', 'cli.help.action.run.resume', 'cli.help.run', { requires: RUN_CHANGE, picks: true }),
  ] },
  { name: 'task', group: 'work', summary: 'cli.help.summary.task', detail: 'cli.help.task', args: '--scope <id> --run <id> --task <id>', bare: 'handler', children: [
    action('inspect', 'observe', 'cli.help.action.task.inspect', 'cli.help.task', { requires: TASK, picks: true }),
    action('execute', 'work', 'cli.help.action.task.execute', 'cli.help.task', { requires: [...TASK, ...ATTEMPT] }),
    action('evaluate', 'work', 'cli.help.action.evaluate', 'cli.help.task', { requires: [...TASK, ...ATTEMPT, '--command-id <id>', '--expected-revision <n>'] }),
    action('accept', 'work', 'cli.help.action.accept', 'cli.help.task', { requires: [...TASK, '--command-id <id>', '--expected-revision <n>'] }),
    action('reject', 'work', 'cli.help.action.reject', 'cli.help.task', { requires: [...TASK, '--command-id <id>', '--expected-revision <n>'] }),
    action('patch-prepare', 'work', 'cli.help.action.patch-prepare', 'cli.help.task', { requires: [...TASK, ...ATTEMPT] }),
    action('patch-preview', 'work', 'cli.help.action.patch-preview', 'cli.help.task', { requires: TASK, picks: true }),
    action('integration-check', 'work', 'cli.help.action.integration-check', 'cli.help.task', { requires: [...TASK, ...ATTEMPT] }),
    action('integration-prepare', 'work', 'cli.help.action.integration-prepare', 'cli.help.task', { requires: [...TASK, ...ATTEMPT, '--command-id <id>', '--proposal <code>'] }),
    action('integration-inspect', 'work', 'cli.help.action.integration-inspect', 'cli.help.task'),
    action('integration-queue-enqueue', 'work', 'queue.cli.summary.enqueue', 'queue.cli.help'),
    action('integration-queue-list', 'observe', 'queue.cli.summary.list', 'queue.cli.help'),
    action('integration-queue-inspect', 'observe', 'queue.cli.summary.inspect', 'queue.cli.help'),
    action('integration-queue-confirm', 'work', 'queue.cli.summary.confirm', 'queue.cli.help'),
    action('integration-queue-rollback', 'work', 'queue.cli.summary.rollback', 'queue.cli.help'),
    action('integration-deliver', 'work', 'cli.help.action.integration-deliver', 'cli.help.task', { requires: [...TASK, ...ATTEMPT, '--command-id <id>', '--candidate-command-id <id>'] }),
    action('integration-adopt', 'work', 'cli.help.action.integration-adopt', 'cli.help.task', { requires: [...TASK, ...ATTEMPT, '--command-id <id>', '--delivery-command-id <id>', '--target <ref>'] }),
    action('integration-rollback', 'work', 'cli.help.action.integration-rollback', 'cli.help.task', { requires: [...TASK, ...ATTEMPT, '--command-id <id>', '--adoption-command-id <id>'] }),
    action('transcript', 'work', 'cli.help.action.transcript', 'cli.help.task', { requires: TASK, picks: true }),
  ] },
  { name: 'pool', group: 'work', summary: 'cli.help.summary.pool', detail: 'cli.help.pool', args: '[--scope <id>] [--pool <id>]', bare: { read: 'status' }, children: [
    action('status', 'work', 'cli.help.action.pool.status', 'cli.help.pool'),
    action('set-capacity', 'work', 'cli.help.action.setCapacity', 'cli.help.pool'),
    action('hold', 'work', 'cli.help.action.hold', 'cli.help.pool'),
    action('resume', 'work', 'cli.help.action.pool.resume', 'cli.help.pool'),
    action('quota-release', 'work', 'cli.help.action.pool.quotaRelease', 'cli.help.pool'),
  ] },
  { name: 'decide', group: 'work', summary: 'cli.help.summary.decide', detail: 'cli.help.decide', args: '[--scope <id>] [--input <file|->]', bare: 'handler', children: [
    action('prepare', 'work', 'cli.help.action.prepare-case', 'cli.help.decide', { requires: INPUT }),
    action('ask', 'work', 'cli.help.action.ask', 'cli.help.decide', { requires: INPUT }),
    action('record', 'work', 'cli.help.action.record', 'cli.help.decide', { requires: INPUT }),
    action('outcome', 'work', 'cli.help.action.outcome', 'cli.help.decide', { requires: INPUT }),
    action('inspect', 'work', 'cli.help.action.decide.inspect', 'cli.help.decide', { requires: INPUT }),
  ] },
  // S4 memory journal v1: reads (list by default, search, inspect) and a person's terminal-card writes (propose, verify, retire; S4B-4 review, purge).
  { name: 'memory', group: 'observe', summary: 'memory.help.summary', detail: 'memory.help.detail', args: '[--scope <id>] [--state <name>] [--json]', bare: 'handler', children: [
    action('search', 'observe', 'memory.help.action.search', 'memory.help.detail', { requires: ['<text>'] }),
    action('inspect', 'observe', 'memory.help.action.inspect', 'memory.help.detail', { requires: ['<id>'] }),
    action('propose', 'observe', 'memory.help.action.propose', 'memory.help.detail', { requires: ['--input <file>'] }),
    action('verify', 'observe', 'memory.help.action.verify', 'memory.help.detail', { requires: ['<id>', '--note <text>'] }),
    action('retire', 'observe', 'memory.help.action.retire', 'memory.help.detail', { requires: ['<id> | --source <run>[/<attempt>]', '--reason <text>'] }),
    // S4B-4: the person's review card (candidates, contests, stale entries) and the purge card.
    action('review', 'observe', 'memory.help.action.review', 'memory.help.detail'),
    action('purge', 'observe', 'memory.help.action.purge', 'memory.help.detail', { requires: ['<id> | --source <run>[/<attempt>]'] }),
    // S4B-7: the read-only rollout status (phase, exit criteria with numbers, the next person action).
    action('rollout', 'observe', 'memory.help.action.rollout', 'memory.help.detail'),
  ] },
  // S7 agent/skill catalog core: reads (agents by default, inspect, skills, skill) and a person's terminal-card writes (define, define-skill).
  { name: 'agents', group: 'observe', summary: 'agents.help.summary', detail: 'agents.help.detail', args: '[--scope <id>] [--json]', bare: 'handler', children: [
    action('inspect', 'observe', 'agents.help.action.inspect', 'agents.help.detail', { requires: ['<id>'] }),
    action('skills', 'observe', 'agents.help.action.skills', 'agents.help.detail'),
    action('skill', 'observe', 'agents.help.action.skill', 'agents.help.detail', { requires: ['<id>'] }),
    action('define', 'observe', 'agents.help.action.define', 'agents.help.detail', { requires: ['--input <file>'] }),
    action('define-skill', 'observe', 'agents.help.action.define-skill', 'agents.help.detail', { requires: ['--input <file>'] }),
    action('signers', 'observe', 'agentsign.help.action.signers', 'agentsign.help.detail'),
    action('enrol-signer', 'observe', 'agentsign.help.action.enrol-signer', 'agentsign.help.detail', { requires: ['--principal <issuer:subject>', '--label <text>'] }),
    action('add-signer', 'observe', 'agentsign.help.action.add-signer', 'agentsign.help.detail', { requires: ['--input <file>'] }),
    action('revoke-signer', 'observe', 'agentsign.help.action.revoke-signer', 'agentsign.help.detail', { requires: ['<id>'] }),
    action('repair-signers', 'observe', 'agentsign.help.action.repair-signers', 'agentsign.help.detail'),
    action('import-skill', 'observe', 'agentsign.help.action.import-skill', 'agentsign.help.detail', { requires: ['--input <file>'] }),
    // S8-2 statistics read; S8-3/S8-4 suggestions (read) and the person's standing, dismiss and reset cards.
    action('stats', 'observe', 'agentstats.help.action.stats', 'agentstats.help'),
    action('suggestions', 'observe', 'agentsevo.help.action.suggestions', 'agentsevo.help'),
    action('promote', 'observe', 'agentsevo.help.action.promote', 'agentsevo.help', { requires: ['<id>', '--work-class <id>'] }),
    action('demote', 'observe', 'agentsevo.help.action.demote', 'agentsevo.help', { requires: ['<id>', '--work-class <id>'] }),
    action('restore', 'observe', 'agentsevo.help.action.restore', 'agentsevo.help', { requires: ['<id>', '--work-class <id>'] }),
    action('retire', 'observe', 'agentsevo.help.action.retire', 'agentsevo.help', { requires: ['<id>', '--work-class <id>'] }),
    action('dismiss', 'observe', 'agentsevo.help.action.dismiss', 'agentsevo.help', { requires: ['<id>'] }),
    // `reset` is the action's fixed word (usage and summary name it), not an argument placeholder: `requires` lists only the flag.
    action('standing', 'observe', 'agentsevo.help.action.standing', 'agentsevo.help', { requires: ['--work-class <id>'] }),
  ] },
  { name: 'models', group: 'models', summary: 'cli.help.summary.models', detail: 'cli.help.models', args: '[--scope <id>] [--declared] [--catalog] [--verbose]', bare: 'handler', children: [
    action('binding', 'models', 'cli.help.action.binding', 'cli.help.modelsBinding', { requires: MODEL }),
    action('activation', 'models', 'cli.help.action.activation', 'cli.help.modelsActivation', { requires: MODEL }),
    action('activate', 'models', 'cli.help.action.models.activate', 'cli.help.modelsActivation', { requires: [...MODEL_CHANGE, '--catalog-revision <id>'], picks: true }),
    action('deactivate', 'models', 'cli.help.action.models.deactivate', 'cli.help.modelsActivation', { requires: MODEL_CHANGE, picks: true }),
    action('invoke', 'models', 'cli.help.action.invoke', 'cli.help.modelsInvocation', { requires: ['--input <file|->'] }),
    action('invocation', 'models', 'cli.help.action.invocation', 'cli.help.modelsInvocation', { requires: ['--input <file|->'] }),
    action('purge-content', 'models', 'cli.help.action.purge-content', 'cli.help.modelsPurgeContent', { requires: ['--input <file|->'] }),
    action('cancel', 'models', 'cli.help.action.models.cancel', 'cli.help.modelsCancelInvocation', { requires: ['--input <file|->'] }),
    action('spending', 'models', 'cli.help.action.spending', 'cli.help.modelsSpending'),
    action('reconcile-spending', 'models', 'cli.help.action.reconcile-spending', 'cli.help.modelsManageSpending', { requires: ['--input <file|->'] }),
    action('create-budget', 'models', 'cli.help.action.create-budget', 'cli.help.modelsBudget', { requires: ['--usd <amount>'] }),
    action('revise-budget', 'models', 'cli.help.action.revise-budget', 'cli.help.modelsBudget', { requires: ['--input <file|-> | --usd <amount>'] }),
    action('audit-spending', 'models', 'cli.help.action.audit-spending', 'cli.help.modelsAuditSpending', { requires: ['--input <file|->'] }),
    action('connect', 'models', 'cli.help.action.models.connect', 'cli.help.modelsConnect', { requires: ['--connection <id>', '--command-id <id>', '--model <id> | --reference <ref>'] }),
    action('login', 'models', 'headless.help.action.login', 'headless.help.login', { requires: ['--connection <id>'] }),
    action('logout', 'models', 'siwc.help.action.logout', 'siwc.help', { requires: ['--connection <id>'] }),
    { name: 'catalog', group: 'models', summary: 'cli.help.action.catalog', detail: 'cli.help.modelsCatalog', children: [
      action('list', 'models', 'cli.help.action.models.catalog.list', 'cli.help.modelsCatalog'),
      action('register', 'models', 'cli.help.action.register', 'cli.help.modelsCatalog', { requires: ['--command-id <id>', '--seed <name> | --file <path>'] }),
      action('activate', 'models', 'cli.help.action.models.catalog.activate', 'cli.help.modelsCatalog', { requires: CATALOG_CHANGE, picks: true }),
      action('deactivate', 'models', 'cli.help.action.models.catalog.deactivate', 'cli.help.modelsCatalog', { requires: CATALOG_CHANGE, picks: true }),
    ] },
    // M2 typed role admission: which exact catalog model serves which role; `set` is a person's card (never AI, pipe or --json).
    { name: 'roles', group: 'models', summary: 'cli.help.action.models.roles', detail: 'climodels.roles.help', children: [
      action('show', 'models', 'cli.help.action.models.roles.show', 'climodels.roles.help'),
      action('set', 'models', 'cli.help.action.models.roles.set', 'climodels.roles.help', { requires: ['--channel <id>', '--model <id>', '--tier <tier>', '--roles <roles> | --no-roles'] }),
    ] },
  ] },
  { name: 'approval', group: 'approvals', summary: 'cli.help.summary.approval', detail: 'cli.approval.help', args: '[--scope <id>] [--input <file|->]', bare: { read: 'list' }, children: [
    action('list', 'approvals', 'cli.help.action.approval.list', 'cli.approval.help'),
    action('inspect', 'approvals', 'cli.help.action.approval.inspect', 'cli.approval.help'),
    action('decide', 'approvals', 'cli.help.action.decide', 'cli.approval.help'),
    action('renew', 'approvals', 'cli.help.action.renew', 'cli.approval.help'),
  ] },
  { name: 'identity', group: 'setup', summary: 'identity.summary', detail: 'identity.help', args: '[--scope <id>] [--verbose]', bare: 'handler', children: [
    action('profiles', 'setup', 'identity.profilesSummary', 'identity.help'),
    action('preview', 'setup', 'identity.previewSummary', 'identity.help'),
    action('choices', 'setup', 'identity.choicesSummary', 'identity.distributionHelp'),
    action('distribute', 'setup', 'identity.distributeSummary', 'identity.distributionHelp'),
  ] },
  // alpha.56 G4: the read-only rollout view of lost-worker recovery and the person's blind review card.
  { name: 'recovery', group: 'approvals', summary: 'cli.help.summary.recovery', detail: 'cli.help.recovery', args: '[--scope <id>] [--json]', bare: 'handler', children: [
    action('review', 'approvals', 'cli.help.action.recoveryReview', 'cli.help.recovery'),
  ] },
  { name: 'policy', group: 'approvals', summary: 'cli.help.summary.policy', detail: 'cli.help.policy', args: '[--scope <id>]', bare: { read: 'status' }, children: [
    action('vocabulary', 'approvals', 'cli.help.action.vocabulary', 'cli.help.policy', { installation: 'independent' }),
    action('status', 'observe', 'cli.help.action.policyStatus', 'cli.help.policyStatus'),
    action('delegations', 'observe', 'policy.delegate.title', 'cli.help.policy'),
    action('delegate', 'approvals', 'policy.delegate.grant', 'cli.help.policy', { requires: ['--step <id>'] }),
    action('undelegate', 'approvals', 'policy.delegate.revoke', 'cli.help.policy', { requires: ['--step <id>'] }),
    action('grants', 'approvals', 'cli.help.action.grants', 'cli.help.policy'),
    action('revoke', 'approvals', 'cli.help.action.revoke', 'cli.help.policy', { requires: ['<id>'] }),
    action('upgrade', 'approvals', 'cli.help.action.policyUpgrade', 'cli.help.policy', { requires: ['--template current'] }),
    // alpha.56 G2 + G3: lost-worker recovery grants and rule promotions (a person's card; off a terminal it only reads).
    action('recovery', 'approvals', 'cli.help.action.policyRecovery', 'cli.help.policy'),
    { name: 'mcp', group: 'approvals', summary: 'cli.help.action.policy.mcp', detail: 'cli.help.policy', children: [
      action('list', 'approvals', 'cli.help.action.policy.mcp.list', 'cli.help.policy'),
      action('grant', 'approvals', 'cli.help.action.policy.mcp.grant', 'cli.help.policy', { requires: ['--group <id>'] }),
      action('revoke', 'approvals', 'cli.help.action.policy.mcp.revoke', 'cli.help.policy', { requires: ['--group <id>'] }),
      action('narrow', 'approvals', 'cli.help.action.policy.mcp.narrow', 'cli.help.policy', { requires: ['--group <id>'] }),
    ] },
    action('scopes', 'observe', 'cli.help.action.policy.scopes', 'cli.help.policy'),
  ] },
  { name: 'config', group: 'setup', summary: 'cli.help.summary.config', detail: 'config.surface.help', installation: 'owned', args: '[<key> [<value>]] [--global]',
    bare: 'handler', children: [
    action('get', 'setup', 'cli.help.action.config.get', 'config.surface.help'),
    action('explain', 'setup', 'cli.help.action.explain', 'config.surface.help'),
    action('validate', 'setup', 'cli.help.action.validate', 'config.surface.help'),
    action('set', 'setup', 'cli.help.action.config.set', 'config.surface.help', { requires: ['<key>', '<value>'], picks: ['<value>'] }),
    action('unset', 'setup', 'cli.help.action.unset', 'config.surface.help', { requires: ['<key>'] }),
  ] },
  { name: 'mcp', group: 'setup', summary: 'cli.help.summary.mcp', detail: 'cli.help.mcp', args: '[<name>] [--check] [--scope local|project|user]', bare: 'handler', children: [
    action('add', 'setup', 'cli.help.action.add', 'cli.help.mcp', { requires: ['<name>'], picks: true }),
    action('add-json', 'setup', 'cli.help.action.add-json', 'cli.help.mcp', { requires: ['<name>', '<json>'] }),
    action('import', 'setup', 'cli.help.action.import', 'cli.help.mcp'),
    action('list', 'setup', 'cli.help.action.mcp.list', 'cli.help.mcp'),
    action('get', 'setup', 'cli.help.action.mcp.get', 'cli.help.mcp', { requires: ['<name>'] }),
    action('remove', 'setup', 'cli.help.action.remove', 'cli.help.mcp', { requires: ['<name>'], picks: true }),
    action('approve', 'setup', 'cli.help.action.approve', 'cli.help.mcp', { requires: ['<name>'], picks: true }),
    action('revoke', 'setup', 'cli.help.action.mcp.revoke', 'cli.help.mcp', { requires: ['<name>'], picks: true }),
  ] },
  { name: 'secret', group: 'setup', summary: 'cli.help.summary.secret', detail: 'cli.help.secret', args: '[<name>] [--scope <id>]', bare: { read: 'list' }, children: [
    action('list', 'setup', 'cli.help.action.secret.list', 'cli.help.secret'),
    action('set', 'setup', 'cli.help.action.secret.set', 'cli.help.secret'),
    action('delete', 'setup', 'cli.help.action.delete', 'cli.help.secret', { requires: ['<name>'] }),
    action('grant', 'setup', 'cli.help.action.secret.grant', 'cli.help.secret'),
    action('revoke', 'setup', 'cli.help.action.secret.revoke', 'cli.help.secret'),
    action('handover', 'setup', 'cli.help.action.secret.handover', 'cli.help.secret'),
    action('store', 'setup', 'cli.help.action.secret.store', 'cli.help.secret'),
  ] },
  { name: 'toolchains', group: 'setup', summary: 'cli.help.summary.toolchains', detail: 'cli.help.toolchains', args: '[update [--apply]]', bare: 'handler', children: [
    action('update', 'setup', 'cli.help.action.update', 'cli.help.toolchains'),
  ] },
  { name: 'doctor', group: 'setup', summary: 'cli.help.summary.doctor', detail: 'cli.help.doctor', args: '[--verbose] [--toolchains] [--json]' },
  { name: 'inventory', group: 'developer', summary: 'cli.help.summary.inventory', detail: 'cli.help.inventory', args: '[--scope <id>] [--after <id>] [--limit <n>]',
    bare: 'handler' },
  { name: 'paths', group: 'developer', summary: 'cli.help.summary.paths', detail: 'cli.help.paths', args: '[--global]' },
  { name: 'runtime', group: 'developer', summary: 'cli.help.summary.runtime', detail: 'cli.help.runtime', bare: { read: 'describe' }, children: [
    action('serve', 'developer', 'cli.help.action.serve', 'cli.help.runtime'),
    action('describe', 'developer', 'cli.help.action.describe', 'cli.help.runtime'),
    action('shutdown', 'developer', 'cli.help.action.shutdown', 'cli.help.runtime'),
    action('restart', 'developer', 'cli.help.action.restart', 'cli.help.runtime'),
  ] },
  { name: 'coding', group: 'developer', summary: 'cli.help.summary.coding', detail: 'cli.coding.help', args: '--input <file|-> | --provider <id> --kind <id>', bare: 'handler', children: [
    action('prepare', 'developer', 'cli.help.action.prepare', 'cli.coding.help', { requires: ['--input <file|->'] }),
    action('template', 'developer', 'cli.help.action.codingTemplate', 'cli.coding.template.help'),
    { name: 'instructions', group: 'developer', summary: 'cli.help.action.coding.instructions', detail: 'cli.coding.instructions.help', children: [
      action('status', 'developer', 'cli.help.action.coding.instructions.status', 'cli.coding.instructions.help'),
      action('trust', 'developer', 'cli.help.action.coding.instructions.trust', 'cli.coding.instructions.help'),
      action('revoke', 'developer', 'cli.help.action.coding.instructions.revoke', 'cli.coding.instructions.help'),
    ] },
  ] },
  { name: 'inference', group: 'developer', summary: 'cli.help.summary.inference', detail: 'cli.help.inference', args: '[--profile <id>]', bare: 'handler', children: [
    action('plan', 'developer', 'cli.help.action.plan', 'cli.help.inference'),
    action('budget', 'developer', 'cli.help.action.budget', 'cli.help.inference'),
    action('metrics', 'developer', 'cli.help.action.metrics', 'cli.help.inference'),
  ] },
  { name: 'operation', group: 'developer', summary: 'cli.help.summary.operation', detail: 'cli.operation.help', args: '--input <file|-> [--wait <ms>]', bare: 'handler', children: [
    action('execute', 'developer', 'cli.help.action.operation.execute', 'cli.operation.help', { requires: INPUT }),
    action('compensate', 'developer', 'cli.help.action.compensate', 'cli.operation.help', { requires: INPUT }),
    action('inspect', 'developer', 'cli.help.action.operation.inspect', 'cli.operation.help', { requires: ['--command-id <id>'] }),
  ] },
 ] as const satisfies readonly CliCommandSpec[];
export type CliCommandName = typeof CLI_CATALOG[number]['name'];

/** Whether a family dispatches the named action now (a `planned` name is not dispatched). */
export function hasCliAction(family: CliCommandName, actionName: string | undefined): boolean {
  const command: CliCommandSpec | undefined = CLI_CATALOG.find(item => item.name === family);
  return command?.children?.some(item => item.name === actionName && !item.planned) ?? false;
}
