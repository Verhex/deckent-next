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
export interface CliCommandSpec { readonly name: string; readonly group: HelpGroup; readonly summary: MessageKey; readonly detail: MessageKey;
  readonly installation?: CliInstallationContract; readonly children?: readonly CliCommandSpec[] }

function action(name: string, group: HelpGroup, summary: MessageKey, detail: MessageKey, installation?: CliInstallationContract): CliCommandSpec {
  return { name, group, summary, detail, ...(installation ? { installation } : {}) };
}

/** The dispatch catalog. Register a command here with its group, localized summary and detail.
 * Children inherit the family handler; existing handlers retain argument validation and execution. */
export const CLI_CATALOG = [
  { name: 'terminal', group: 'start', summary: 'cli.help.summary.terminal', detail: 'cli.help.terminal', children: [
    action('workline', 'start', 'cli.help.action.workline', 'cli.help.terminal'),
    action('session', 'start', 'cli.help.action.session', 'cli.help.terminal'),
    action('status', 'start', 'cli.help.action.terminal.status', 'cli.help.terminal'),
    action('chat-plan', 'start', 'cli.help.action.chat-plan', 'cli.help.terminal'),
    action('snapshot', 'start', 'cli.help.action.snapshot', 'cli.help.terminal'),
  ] },
  { name: 'init', group: 'start', summary: 'cli.help.summary.init', detail: 'cli.help.initPreview', installation: 'owned', children: [
    action('preview', 'start', 'cli.help.action.preview', 'cli.help.initPreview'),
    action('inspect', 'start', 'cli.help.action.init.inspect', 'cli.help.initPreview'),
    action('apply', 'start', 'cli.help.action.apply', 'cli.help.initPreview'),
    action('resume', 'start', 'cli.help.action.init.resume', 'cli.help.initPreview'),
    action('identity', 'start', 'cli.help.action.identity', 'cli.help.identity'),
    action('policy', 'start', 'cli.help.action.policy', 'cli.help.initPreview'),
  ] },
  { name: 'monitor', group: 'observe', summary: 'cli.help.summary.monitor', detail: 'cli.monitor.help' },
  { name: 'workers', group: 'observe', summary: 'cli.help.summary.workers', detail: 'cli.workers.help', children: [
    action('list', 'observe', 'cli.help.action.workers.list', 'cli.workers.help'),
    action('watch', 'observe', 'cli.help.action.watch', 'cli.workers.help'),
  ] },
  { name: 'run', group: 'work', summary: 'cli.help.summary.run', detail: 'cli.help.run', children: [
    action('create', 'work', 'cli.help.action.create', 'cli.help.run'),
    action('reserve', 'work', 'cli.help.action.reserve', 'cli.help.run'),
    action('inspect', 'work', 'cli.help.action.run.inspect', 'cli.help.run'),
    action('cancel', 'work', 'cli.help.action.run.cancel', 'cli.help.run'),
    action('close', 'work', 'cli.help.action.close', 'cli.help.run'),
    action('resume', 'work', 'cli.help.action.run.resume', 'cli.help.run'),
  ] },
  { name: 'task', group: 'work', summary: 'cli.help.summary.task', detail: 'cli.help.task', children: [
    action('inspect', 'observe', 'cli.help.action.task.inspect', 'cli.help.task'),
    action('execute', 'work', 'cli.help.action.task.execute', 'cli.help.task'),
    action('evaluate', 'work', 'cli.help.action.evaluate', 'cli.help.task'),
    action('accept', 'work', 'cli.help.action.accept', 'cli.help.task'),
    action('reject', 'work', 'cli.help.action.reject', 'cli.help.task'),
    action('patch-prepare', 'work', 'cli.help.action.patch-prepare', 'cli.help.task'),
    action('patch-preview', 'work', 'cli.help.action.patch-preview', 'cli.help.task'),
    action('integration-check', 'work', 'cli.help.action.integration-check', 'cli.help.task'),
    action('integration-prepare', 'work', 'cli.help.action.integration-prepare', 'cli.help.task'),
    action('integration-inspect', 'work', 'cli.help.action.integration-inspect', 'cli.help.task'),
    action('integration-deliver', 'work', 'cli.help.action.integration-deliver', 'cli.help.task'),
    action('integration-adopt', 'work', 'cli.help.action.integration-adopt', 'cli.help.task'),
    action('integration-rollback', 'work', 'cli.help.action.integration-rollback', 'cli.help.task'),
    action('transcript', 'work', 'cli.help.action.transcript', 'cli.help.task'),
  ] },
  { name: 'pool', group: 'work', summary: 'cli.help.summary.pool', detail: 'cli.help.pool', children: [
    action('status', 'work', 'cli.help.action.pool.status', 'cli.help.pool'),
    action('set-capacity', 'work', 'cli.help.action.setCapacity', 'cli.help.pool'),
    action('hold', 'work', 'cli.help.action.hold', 'cli.help.pool'),
    action('resume', 'work', 'cli.help.action.pool.resume', 'cli.help.pool'),
  ] },
  { name: 'decide', group: 'work', summary: 'cli.help.summary.decide', detail: 'cli.help.decide', children: [
    action('prepare', 'work', 'cli.help.action.prepare-case', 'cli.help.decide'),
    action('ask', 'work', 'cli.help.action.ask', 'cli.help.decide'),
    action('record', 'work', 'cli.help.action.record', 'cli.help.decide'),
    action('outcome', 'work', 'cli.help.action.outcome', 'cli.help.decide'),
    action('inspect', 'work', 'cli.help.action.decide.inspect', 'cli.help.decide'),
  ] },
  { name: 'models', group: 'models', summary: 'cli.help.summary.models', detail: 'cli.help.models', children: [
    action('binding', 'models', 'cli.help.action.binding', 'cli.help.modelsBinding'),
    action('activation', 'models', 'cli.help.action.activation', 'cli.help.modelsActivation'),
    action('activate', 'models', 'cli.help.action.models.activate', 'cli.help.modelsActivation'),
    action('deactivate', 'models', 'cli.help.action.models.deactivate', 'cli.help.modelsActivation'),
    action('invoke', 'models', 'cli.help.action.invoke', 'cli.help.modelsInvocation'),
    action('invocation', 'models', 'cli.help.action.invocation', 'cli.help.modelsInvocation'),
    action('purge-content', 'models', 'cli.help.action.purge-content', 'cli.help.modelsPurgeContent'),
    action('cancel', 'models', 'cli.help.action.models.cancel', 'cli.help.modelsCancelInvocation'),
    action('spending', 'models', 'cli.help.action.spending', 'cli.help.modelsSpending'),
    action('reconcile-spending', 'models', 'cli.help.action.reconcile-spending', 'cli.help.modelsManageSpending'),
    action('revise-budget', 'models', 'cli.help.action.revise-budget', 'cli.help.modelsManageSpending'),
    action('audit-spending', 'models', 'cli.help.action.audit-spending', 'cli.help.modelsAuditSpending'),
    action('connect', 'models', 'cli.help.action.models.connect', 'cli.help.modelsConnect'),
    { name: 'catalog', group: 'models', summary: 'cli.help.action.catalog', detail: 'cli.help.modelsCatalog', children: [
      action('list', 'models', 'cli.help.action.models.catalog.list', 'cli.help.modelsCatalog'),
      action('register', 'models', 'cli.help.action.register', 'cli.help.modelsCatalog'),
      action('activate', 'models', 'cli.help.action.models.catalog.activate', 'cli.help.modelsCatalog'),
      action('deactivate', 'models', 'cli.help.action.models.catalog.deactivate', 'cli.help.modelsCatalog'),
    ] },
  ] },
  { name: 'approval', group: 'approvals', summary: 'cli.help.summary.approval', detail: 'cli.approval.help', children: [
    action('list', 'approvals', 'cli.help.action.approval.list', 'cli.approval.help'),
    action('inspect', 'approvals', 'cli.help.action.approval.inspect', 'cli.approval.help'),
    action('decide', 'approvals', 'cli.help.action.decide', 'cli.approval.help'),
    action('renew', 'approvals', 'cli.help.action.renew', 'cli.approval.help'),
  ] },
  { name: 'identity', group: 'setup', summary: 'identity.summary', detail: 'identity.help', children: [
    action('profiles', 'setup', 'identity.profilesSummary', 'identity.help'),
    action('preview', 'setup', 'identity.previewSummary', 'identity.help'),
  ] },
  { name: 'policy', group: 'approvals', summary: 'cli.help.summary.policy', detail: 'cli.help.policy', children: [
    action('vocabulary', 'approvals', 'cli.help.action.vocabulary', 'cli.help.policy', 'independent'),
    action('grants', 'approvals', 'cli.help.action.grants', 'cli.help.policy'),
    action('revoke', 'approvals', 'cli.help.action.revoke', 'cli.help.policy'),
    action('upgrade', 'approvals', 'cli.help.action.policyUpgrade', 'cli.help.policy'),
  ] },
  { name: 'config', group: 'setup', summary: 'cli.help.summary.config', detail: 'config.surface.help', installation: 'owned', children: [
    action('get', 'setup', 'cli.help.action.config.get', 'config.surface.help'),
    action('explain', 'setup', 'cli.help.action.explain', 'config.surface.help'),
    action('validate', 'setup', 'cli.help.action.validate', 'config.surface.help'),
    action('set', 'setup', 'cli.help.action.config.set', 'config.surface.help'),
    action('unset', 'setup', 'cli.help.action.unset', 'config.surface.help'),
  ] },
  { name: 'mcp', group: 'setup', summary: 'cli.help.summary.mcp', detail: 'cli.help.mcp', children: [
    action('add', 'setup', 'cli.help.action.add', 'cli.help.mcp'),
    action('add-json', 'setup', 'cli.help.action.add-json', 'cli.help.mcp'),
    action('import', 'setup', 'cli.help.action.import', 'cli.help.mcp'),
    action('list', 'setup', 'cli.help.action.mcp.list', 'cli.help.mcp'),
    action('get', 'setup', 'cli.help.action.mcp.get', 'cli.help.mcp'),
    action('remove', 'setup', 'cli.help.action.remove', 'cli.help.mcp'),
    action('approve', 'setup', 'cli.help.action.approve', 'cli.help.mcp'),
    action('revoke', 'setup', 'cli.help.action.mcp.revoke', 'cli.help.mcp'),
  ] },
  { name: 'secret', group: 'setup', summary: 'cli.help.summary.secret', detail: 'cli.help.secret', children: [
    action('list', 'setup', 'cli.help.action.secret.list', 'cli.help.secret'),
    action('set', 'setup', 'cli.help.action.secret.set', 'cli.help.secret'),
    action('delete', 'setup', 'cli.help.action.delete', 'cli.help.secret'),
  ] },
  { name: 'toolchains', group: 'setup', summary: 'cli.help.summary.toolchains', detail: 'cli.help.toolchains', children: [
    action('update', 'setup', 'cli.help.action.update', 'cli.help.toolchains'),
  ] },
  { name: 'doctor', group: 'setup', summary: 'cli.help.summary.doctor', detail: 'cli.help.doctor' },
  { name: 'inventory', group: 'developer', summary: 'cli.help.summary.inventory', detail: 'cli.help.inventory' },
  { name: 'paths', group: 'developer', summary: 'cli.help.summary.paths', detail: 'cli.help.paths' },
  { name: 'runtime', group: 'developer', summary: 'cli.help.summary.runtime', detail: 'cli.help.runtime', children: [
    action('serve', 'developer', 'cli.help.action.serve', 'cli.help.runtime'),
    action('describe', 'developer', 'cli.help.action.describe', 'cli.help.runtime'),
    action('shutdown', 'developer', 'cli.help.action.shutdown', 'cli.help.runtime'),
    action('restart', 'developer', 'cli.help.action.restart', 'cli.help.runtime'),
  ] },
  { name: 'coding', group: 'developer', summary: 'cli.help.summary.coding', detail: 'cli.coding.help', children: [
    action('prepare', 'developer', 'cli.help.action.prepare', 'cli.coding.help'),
  ] },
  { name: 'inference', group: 'developer', summary: 'cli.help.summary.inference', detail: 'cli.help.inference', children: [
    action('plan', 'developer', 'cli.help.action.plan', 'cli.help.inference'),
    action('budget', 'developer', 'cli.help.action.budget', 'cli.help.inference'),
    action('metrics', 'developer', 'cli.help.action.metrics', 'cli.help.inference'),
  ] },
  { name: 'operation', group: 'developer', summary: 'cli.help.summary.operation', detail: 'cli.operation.help', children: [
    action('execute', 'developer', 'cli.help.action.operation.execute', 'cli.operation.help'),
    action('compensate', 'developer', 'cli.help.action.compensate', 'cli.operation.help'),
    action('inspect', 'developer', 'cli.help.action.operation.inspect', 'cli.operation.help'),
  ] },
 ] as const satisfies readonly CliCommandSpec[];
export type CliCommandName = typeof CLI_CATALOG[number]['name'];

export function hasCliAction(family: CliCommandName, actionName: string | undefined): boolean {
  const command: CliCommandSpec | undefined = CLI_CATALOG.find(item => item.name === family);
  return command?.children?.some(item => item.name === actionName) ?? false;
}
