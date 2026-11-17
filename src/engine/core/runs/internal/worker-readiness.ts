import { resolveTaskWorkClass, resolveWorkClassCandidates, isCandidateSelector, type ExecutionRegistry, type ExecutionProfileDefinition, type CatalogPinModelEvidence, type WorkInput, type WorkerAssignmentSkip, type WorkerReadiness } from '#domain/index.js';
import { assignTaskWorker, type WorkerAssignmentContext } from './worker-assignment.js';
import { WorkerModelAdmissionError, type ModelCatalogReader } from '#engine/core/model-activation/index.js';

type Template = Readonly<{ profile: ExecutionProfileDefinition; provider: string }>;
/** Same small assignment and model admission as a Run, followed by its existing same-login binding check. Reads only. */
export async function inspectWorkerReadiness(registry: ExecutionRegistry, templates: readonly Template[], reader: ModelCatalogReader, context: WorkerAssignmentContext,
  compile: (template: ExecutionProfileDefinition, input: WorkInput, evidence?: CatalogPinModelEvidence) => ExecutionProfileDefinition,
  connected: (template: ExecutionProfileDefinition, model: NonNullable<WorkInput['model']>) => Promise<boolean>): Promise<WorkerReadiness> {
  const missing = (code: string, cli: readonly string[]): WorkerReadiness => ({ ready: false, code, cli });
  const { policy, workClass } = resolveTaskWorkClass('small', undefined, registry.workClasses), scopeId = context.scopeId;
  const candidates = workClass && resolveWorkClassCandidates(policy, workClass), channels = await reader.channels();
  if (!templates.length) return { ready: true, code: '', cli: [] }; // Other adapters keep their own admission owner.
  let failure = missing('WORKER_ASSIGNMENT_NONE', ['deckent', 'coding']);
  const input: WorkInput = { schemaVersion: 2, task: workClass?.id ?? 'small', acceptance: workClass?.id ?? 'small', scope: { paths: ['.readiness'] } };
  for (const { profile: template, provider } of templates) {
    const kind = registry.kinds.find(row => row.profile.id === template.id && row.profile.version === template.version);
    if (!kind) continue;
    const candidate = candidates?.candidates.find(row => !isCandidateSelector(row) && channels.some(channel => channel.channelId === row.channelId && channel.channel.kind === 'native-cli' && channel.channel.cli === provider));
    const next = candidate && !isCandidateSelector(candidate) ? ['deckent', 'models', 'connect', '--scope', scopeId, '--connection', candidate.channelId, '--model', candidate.modelId] : ['deckent', 'models', 'roles', '--scope', scopeId];
    const skipped: WorkerAssignmentSkip[] = [];
    try {
      const assigned = await assignTaskWorker({ id: kind.kind, kind: kind.kind, workClass: workClass?.id }, input, template, registry.workClasses, reader, compile, context, row => skipped.push(row));
      const model = assigned.input.model!;
      if (!await connected(template, model)) { failure = missing('WORKER_MODEL_BINDING_MISMATCH', ['deckent', 'models', 'connect', '--scope', scopeId, '--connection', model.channelId, '--model', model.modelId]); continue; }
      return { ready: true, code: '', cli: [] };
    } catch (error) {
      if (!(error instanceof WorkerModelAdmissionError)) throw error;
      const cause = skipped.find(row => channels.some(channel => channel.channelId === row.channelId && channel.channel.kind === 'native-cli' && channel.channel.cli === provider));
      const cli = cause?.reason === 'WORKER_MODEL_ROLE_REFUSED' ? ['deckent', 'models', 'roles', 'set', '--scope', scopeId, '--channel', cause.channelId, '--model', cause.modelId, '--tier', '<tier>', '--roles', '<roles>']
        : cause?.reason === 'WORKER_MODEL_CLI_TOO_OLD' ? ['deckent', 'toolchains', 'update']
        : cause && ['WORKER_MODEL_UNKNOWN', 'WORKER_MODEL_RETIRED', 'WORKER_MODEL_NOT_CURRENT', 'WORKER_MODEL_ALIAS_REFUSED'].includes(cause.reason) ? ['deckent', 'models', '--scope', scopeId] : next;
      failure = missing(cause?.reason ?? error.code, cli);
    }
  }
  return failure;
}
