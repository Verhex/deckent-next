import { parseModelActivationQuery, type ModelActivationQuery, type ModelActivationRecord } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { verifyModelActivationRecord } from './evidence.js';
import { ModelActivationStoreError } from './port.js';
import type { ModelActivationAuthorizer } from './application.js';

export interface ModelActivationReader {
  loadRecord(scopeId: string, reference: ModelActivationQuery['reference']): Promise<ModelActivationRecord | null>;
  close(): void;
}
export type ModelActivationInspection = Readonly<{ schemaVersion: 1; scopeId: string;
  reference: ModelActivationQuery['reference']; activation: ModelActivationRecord | null; availability: 'not-observed' }>;

export class ModelActivationInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelActivationAuthorizer,
    private readonly openReader: () => Promise<ModelActivationReader>) {}
  async inspect(input: unknown, credential?: unknown): Promise<ModelActivationInspection> {
    const query = parseModelActivationQuery(input);
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    const reader = await this.openReader();
    try {
      const stored = await reader.loadRecord(query.scopeId, query.reference);
      let activation: ModelActivationRecord | null = null;
      if (stored !== null) {
        activation = verifyModelActivationRecord(stored);
        if (activation.scopeId !== query.scopeId || JSON.stringify(activation.reference) !== JSON.stringify(query.reference)) {
          throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT');
        }
      }
      return Object.freeze({ schemaVersion: 1, scopeId: query.scopeId, reference: query.reference,
        activation, availability: 'not-observed' });
    } finally { reader.close(); }
  }
}
