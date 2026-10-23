export * from './internal/contract.js';
export { CatalogEvolutionApplication, catalogModelFacts } from './internal/application.js';
export { catalogEntries, keyStats, effortRatioMicro, rollupStats, mergeEntries, keepWindow, windowRows, type CatalogEntries, type CatalogEntry } from './internal/aggregate.js';
export { agentRuleCandidates, workClassRuleCandidates, lessonRuleCandidates, catalogSuggestionRecord, lessonSetDigest, catalogDraftTemplate, CATALOG_DRAFT_TEMPLATES, type RuleCandidate,
  type CatalogLessonSource } from './internal/rules.js';
export { renderCatalogDraft, catalogDraftDigest, catalogDraftMinLessons, catalogEvolutionRegistryAvailable, type CatalogDraft } from './internal/drafts.js';
