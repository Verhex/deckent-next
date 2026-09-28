export { ensureScratchDirectories, openScratchSession, SCRATCH_FILE_TARGET_KIND, SCRATCH_FILE_WRITE_OPERATION, SCRATCH_TOOL_SPECS, SCRATCH_WALK_MAX_DEPTH,
  SCRATCH_WALK_MAX_ENTRIES, ScratchError, scratchSessionKey, scratchUsage, type ScratchLimits, type ScratchSession } from './internal/area.js';
export { clearScratchSession, createScratchActivity, inspectScratchSession, startScratchSweeper, sweepScratch, type ScratchActivity, type ScratchContents,
  type ScratchSweepResult } from './internal/sweep.js';
