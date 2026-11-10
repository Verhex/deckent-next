export { ABSENT_FILE_VERSION, WORKSPACE_WRITE_MAX_FILE_BYTES, deleteWorkspaceFile, ensureWorkspaceParents, fileContentVersion, readWritableFile, EMPTY_DIRECTORY_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ NON_EMPTY_DIRECTORY_VERSION, readWritableDirectory, removeWorkspaceDirectory,
  resolveWritable, writablePath, writeWorkspaceFile,
  WorkspaceWriteError, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type CurrentFile, type WritablePath } from './internal/files.js';
export { unifiedDiff } from './internal/diff.js';
export { isDirectoryWriteApprovalFloored, isWriteApprovalFloored, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ WORKSPACE_WRITE_APPROVAL_FLOOR, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SELF_SOURCE_WRITE_APPROVAL_FLOOR, isSelfSourceWriteFloored, isAnyWriteFloored } from './internal/floor.js';
export { agentFileEffectCommandId, planWorkspaceEdit, projectEditArea, WORKSPACE_EDIT_TOOL_SPECS, WORKSPACE_FILE_TARGET_KIND,
  WORKSPACE_FILE_WRITE_OPERATION, WorkspaceFileTarget, type WorkspaceEditArea, type WorkspaceEditPlan } from './internal/target.js';
