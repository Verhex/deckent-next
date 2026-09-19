import { parseProviderCatalog, type ProviderCatalog } from '#domain/index.js';

export type DeclaredModelsInspection = Readonly<{
  schemaVersion: 1; availability: 'not-observed';
} & ({ status: 'not-configured'; catalog: null } | { status: 'declared'; catalog: ProviderCatalog })>;
export interface ProviderCatalogSource { read(): Promise<unknown | undefined> }

/** Declaration is configuration evidence only. This application cannot activate or invoke a model. */
export class DeclaredModelsApplication {
  constructor(private readonly source: ProviderCatalogSource) {}
  async inspect(): Promise<DeclaredModelsInspection> {
    const authored = await this.source.read();
    if (authored === undefined) return Object.freeze({ schemaVersion: 1, status: 'not-configured', availability: 'not-observed', catalog: null });
    return Object.freeze({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: parseProviderCatalog(authored) });
  }
}
