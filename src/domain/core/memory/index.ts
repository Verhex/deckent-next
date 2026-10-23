export * from './internal/contract.js';
export { proposeMemoryEntry, verifyMemoryEntry, retireMemoryEntry } from './internal/lifecycle.js';
export { foldMemoryText, memorySearchTerms, memoryIndexText, memoryEntryMatches } from './internal/search.js';
export { composeMemoryAutomation, memoryAutomationOverlaySchema, memoryExtractionAllowed, MEMORY_EXTRACTORS, MEMORY_TEMPLATES, memoryTemplate, memoryExtractionSourceSchema,
  distilMemoryCandidates, memoryWorkClassOf } from './internal/automation.js';
export type { MemoryAutomation, MemoryWorkClassRow, MemoryExtractionSource, MemoryCandidate } from './internal/automation.js';
