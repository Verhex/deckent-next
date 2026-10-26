import { z } from 'zod';
import { setupProfileRefSchema, type SetupFamilyPackage } from './contract.js';

/** Shared install preview; terminal first-open recovery consumes this same contract. No completion flag is persisted. */
export type SetupPermissionPreview = Readonly<{
  state: 'needs-profile' | 'needs-confirmation' | 'applied' | 'not-applicable' | 'blocked';
  reason: string; digest: string; configDigest: string; profileDigest: string; grantRevision: string | null; revision: string; modeRevision: string | null;
  scopeId: string; principal: string; profile: string; selectedProfile: { readonly id: string; readonly version: number } | null;
  profiles: readonly { readonly id: string; readonly version: number }[];
  currentMode: 'standart' | 'full-auto' | 'full-access'; effectiveMode: 'standart' | 'full-auto' | 'full-access';
  mode: 'standart' | 'full-auto' | 'full-access'; preserveMode: boolean;
}>;
const facts = z.object({ state: z.enum(['needs-profile', 'needs-confirmation', 'applied', 'not-applicable', 'blocked']),
  digest: z.string(), profile: z.string(), mode: z.enum(['standart', 'full-auto', 'full-access']), effectiveMode: z.enum(['standart', 'full-auto', 'full-access']), principal: z.string(),
  selectedProfile: setupProfileRefSchema.nullable() }).strict().nullable();
/** Permission defaults are an install responsibility. Every write still needs the carrier's witness, preview and conditional owners. */
export const SETUP_PERMISSIONS_FAMILY: SetupFamilyPackage = {
  namespace: 'permissions', source: 'core:setup-permissions', facts,
  stages: [{ id: 'permissions:start-mode', after: 'core:policy', title: 'setup.permissions.title', phase: 'install',
    evaluate({ facts: value, scopeId }) {
      const preview = facts.parse(value);
      if (!preview || !scopeId) return { state: 'blocked', reason: { code: 'setup.permissions.waitsForPolicy', params: {} } };
      const params = { profile: preview.profile, mode: preview.mode, principal: preview.principal, scope: scopeId, effective: preview.effectiveMode };
      if (preview.state === 'applied') return { state: 'done', reason: { code: 'setup.permissions.applied', params } };
      if (preview.state === 'not-applicable') return { state: 'skipped', reason: { code: 'setup.permissions.notApplicable', params } };
      if (preview.state !== 'needs-confirmation') return { state: 'blocked', reason: { code: preview.state === 'needs-profile' ? 'setup.permissions.profileMissing' : 'setup.permissions.blocked', params } };
      return { state: 'ready', reason: { code: 'setup.permissions.preview', params }, operation: { id: 'setup.permissions', version: 1,
        input: { scopeId, digest: preview.digest, profile: preview.selectedProfile } } };
    } }],
};
