import { FileResourceTraceStore } from '#adapters/index.js';
import { ResourceCollector, projectResourceView, unavailableResourceView, readSealedWorkerEvents, type WorkCostEvidence } from '#engine/index.js';
import { FileArtifactStore } from '#adapters/index.js';
import { prepareProductDirectory, inspectProductDirectory, type DeckentConfig, type ProductLayout } from '#platform/index.js';
import type { AttemptIdentity } from '#domain/index.js';
const collectors = new Map<string, ResourceCollector>();
export function configuredResourceCollector(config: DeckentConfig, layout: ProductLayout): ResourceCollector {
  const key = JSON.stringify([layout.root, config.resourceObservation]);
  let collector = collectors.get(key);
  if (!collector) { collector = new ResourceCollector(new FileResourceTraceStore(() => prepareProductDirectory(layout, 'brain'), config.resourceObservation), config.resourceObservation); collectors.set(key, collector); }
  return collector;
}
export async function inspectConfiguredResources(config: DeckentConfig, layout: ProductLayout, identity: AttemptIdentity) {
  if (!config.resourceObservation.enabled) return unavailableResourceView('disabled');
  try { return projectResourceView(identity, await new FileResourceTraceStore(() => inspectProductDirectory(layout, 'brain'), config.resourceObservation).read(identity), Date.now(), config.resourceObservation.staleMs); }
  catch (error) { return unavailableResourceView(error instanceof Error && error.message === 'RESOURCE_TRACE_UNSUPPORTED' ? 'unsupported' : 'store-unavailable'); }
}
export function configuredWorkCostEvidence(config: DeckentConfig, layout: ProductLayout,
  store: Pick<WorkCostEvidence, 'readDispatch' | 'readMetrics'> & Pick<import('#engine/index.js').WorkerEventLogStore, 'loadWorkerEventLog'>): WorkCostEvidence {
  const artifacts = FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes);
  return { now: Date.now, comparison: { registry: config.admission?.registry, policy: config.resourceObservation.recommendation }, readResources: identity => inspectConfiguredResources(config, layout, identity), readDispatch: store.readDispatch, ...(store.readMetrics ? { readMetrics: store.readMetrics } : {}),
    readEvents: identity => readSealedWorkerEvents(store, artifacts, identity) };
}
