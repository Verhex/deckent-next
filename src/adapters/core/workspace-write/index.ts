export { ABSENT_FILE_VERSION, WORKSPACE_WRITE_MAX_FILE_BYTES, deleteWorkspaceFile, ensureWorkspaceParents, fileContentVersion, readWritableFile, EMPTY_DIRECTORY_VERSION, NON_EMPTY_DIRECTORY_VERSION, readWritableDirectory, removeWorkspaceDirectory,
  resolveWritable, writablePath, writeWorkspaceFile,
  WorkspaceWriteError, type CurrentFile, type WritablePath } from './internal/files.js';
export { unifiedDiff } from './internal/diff.js';
export { isWriteApprovalFloored, planWorkspaceEdit, projectEditArea, WORKSPACE_EDIT_TOOL_SPECS, WORKSPACE_WRITE_APPROVAL_FLOOR, WORKSPACE_FILE_TARGET_KIND,
  WORKSPACE_FILE_WRITE_OPERATION, WorkspaceFileTarget, type WorkspaceEditArea, type WorkspaceEditPlan } from './internal/target.js';
