export { ensureScratchDirectories, openScratchSession, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SCRATCH_FILE_TARGET_KIND, SCRATCH_FILE_WRITE_OPERATION, SCRATCH_TOOL_SPECS, SCRATCH_WALK_MAX_DEPTH,
  SCRATCH_WALK_MAX_ENTRIES, ScratchError, scratchSessionKey, scratchUsage, type ScratchLimits, type ScratchSession } from './internal/area.js';
export { createScratchActivity, type ScratchActivity } from './internal/custody.js';
export { clearScratchSession, inspectScratchSession, startScratchSweeper, sweepScratch, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ScratchContents, type ScratchSweepResult } from './internal/sweep.js';
