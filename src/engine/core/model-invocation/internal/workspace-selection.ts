import { isDeepStrictEqual } from 'node:util';
import { modelInvocationProfileSchema, type ModelInvocationProfile, type ModelReference } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { planProfileChanges, type ProfileChange } from '#engine/core/model-activation/index.js';

export type InvocationWorkspace = Readonly<{ id: string; name: string }>;
export interface WorkspaceSelectionContext { readonly identity: string; readonly profiles: readonly ModelInvocationProfile[] }
type Snapshot = Readonly<{ global: Record<string, unknown>; project: Record<string, unknown>; digest: string | null }>;
export interface WorkspaceSelectionPorts<C extends WorkspaceSelectionContext> {
  read(): Promise<C>;
  eligible(profile: ModelInvocationProfile): boolean;
  authorize(profile: ModelInvocationProfile, context: C): Promise<void>;
  credential(profile: ModelInvocationProfile, context: C): Promise<string | undefined>;
  discover(profile: ModelInvocationProfile, key: string): Promise<readonly InvocationWorkspace[]>;
  snapshots(): Promise<readonly [Snapshot, Snapshot]>;
  offer(profile: ModelInvocationProfile, selected: InvocationWorkspace, choices: readonly InvocationWorkspace[]): ProfileChange<InvocationWorkspace> | null;
}

/** Ephemeral selection application. It owns fresh scope/profile identity, choice custody and the preview; the config application owns publication. */
export async function openInvocationWorkspaceSelection<C extends WorkspaceSelectionContext>(scopeId: string, ports: WorkspaceSelectionPorts<C>) {
  const context = await ports.read(), candidates = context.profiles.filter(profile => profile.scopeId === scopeId && ports.eligible(profile));
  const discoveries = new Map<string, readonly InvocationWorkspace[]>();
  const fresh = async (id: string) => {
    const original = candidates.find(profile => profile.id === id), current = await ports.read();
    const profile = current.profiles.find(value => value.scopeId === scopeId && value.id === id);
    if (!original || !profile || current.identity !== context.identity || !isDeepStrictEqual(profile, original)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    await ports.authorize(profile, current); return { profile, current };
  };
  const visible: { id: string; reference: ModelReference; workspaceId: string | null }[] = [];
  for (const profile of candidates) {
    try { await ports.authorize(profile, context); visible.push({ id: profile.id, reference: profile.reference,
      workspaceId: typeof profile.adapter.definition['workspaceId'] === 'string' ? profile.adapter.definition['workspaceId'] : null });
    } catch { /* Denied profiles expose neither credential nor workspace metadata. */ }
  }
  const list = async (id: string): Promise<readonly InvocationWorkspace[]> => {
    try {
      const { profile, current } = await fresh(id), key = await ports.credential(profile, current);
      await fresh(id); if (!key) throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE');
      const choices = await ports.discover(profile, key); await fresh(id);
      discoveries.set(id, choices); return choices;
    } catch { throw ErrorRegistry.createError('MODEL_CONNECT_DISCOVERY_UNAVAILABLE'); }
  };
  return { profiles: visible, list,
    async plan(id: string, workspaceId: string) {
      const choices = discoveries.get(id), selected = choices?.find(row => row.id === workspaceId);
      if (!choices || !selected) throw ErrorRegistry.createError('MODEL_CONNECT_DEFINITION_INVALID');
      if (!(await list(id)).some(row => row.id === selected.id && row.name === selected.name)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      const { profile } = await fresh(id), [global, project] = await ports.snapshots();
      if (!isDeepStrictEqual(global.global, project.global) || !isDeepStrictEqual(global.project, project.project)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      const plan = planProfileChanges({ global: global.global, project: project.project }, scopeId, value => {
        const parsed = modelInvocationProfileSchema.parse(value);
        return parsed.id === id && isDeepStrictEqual(parsed, profile) ? ports.offer(parsed, selected, choices) : null;
      });
      if (!plan.models.length && !plan.shared.length && profile.adapter.definition['workspaceId'] !== selected.id) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      return { ...plan, writes: plan.writes.map(write => ({ ...write, expect: (write.layer === 'global' ? global : project).digest })) };
    },
  };
}
