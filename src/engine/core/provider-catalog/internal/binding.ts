import { createHash } from 'node:crypto';
import { parseModelReference, parseProviderCatalog, resolveModelBindingDefinition, encodeModelBindingDefinition,
  type ModelReference, type ModelBindingDefinition } from '#domain/index.js';
import type { ProviderCatalogSource } from './application.js';

export type ModelBindingInspection = Readonly<{
  schemaVersion: 1;
  reference: ModelReference;
  availability: 'not-observed';
} & (
  { status: 'not-configured'; catalogRevision: null; definition: null; binding: null }
  | { status: 'not-declared'; catalogRevision: string; definition: null; binding: null }
  | { status: 'declared'; catalogRevision: string; definition: ModelBindingDefinition;
    binding: Readonly<{ encodingVersion: 1; algorithm: 'sha256'; digest: string }> }
)>;

/** A content binding identifies an exact declaration. It grants no activation or invocation authority. */
export class ModelBindingApplication {
  constructor(private readonly source: ProviderCatalogSource) {}
  async inspect(input: unknown): Promise<ModelBindingInspection> {
    const reference = parseModelReference(input);
    const base = { schemaVersion: 1 as const, reference, availability: 'not-observed' as const };
    const authored = await this.source.read();
    if (authored === undefined) return Object.freeze({ ...base, status: 'not-configured',
      catalogRevision: null, definition: null, binding: null });
    const catalog = parseProviderCatalog(authored);
    const definition = resolveModelBindingDefinition(catalog, reference);
    if (definition === null) return Object.freeze({ ...base, status: 'not-declared',
      catalogRevision: catalog.revision, definition: null, binding: null });
    const digest = createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex');
    return Object.freeze({ ...base, status: 'declared', catalogRevision: catalog.revision, definition,
      binding: Object.freeze({ encodingVersion: 1, algorithm: 'sha256', digest }) });
  }
}
