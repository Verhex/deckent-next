export { ensureScratchDirectories, openScratchSession, SCRATCH_FILE_TARGET_KIND, SCRATCH_FILE_WRITE_OPERATION, SCRATCH_TOOL_SPECS, SCRATCH_WALK_MAX_DEPTH,
  SCRATCH_WALK_MAX_ENTRIES, ScratchError, scratchSessionKey, scratchUsage, type ScratchLimits, type ScratchSession } from './internal/area.js';
export { createScratchActivity, type ScratchActivity } from './internal/custody.js';
export { clearScratchSession, inspectScratchSession, startScratchSweeper, sweepScratch, type ScratchContents, type ScratchSweepResult } from './internal/sweep.js';
