import { describe, expect, it } from 'vitest';
import { HOST_SHELL_RUN_OPERATION, RUN_SHELL_TOOL_SPEC } from '#adapters/core/host-shell/index.js';
import { SCRATCH_FILE_WRITE_OPERATION, SCRATCH_TOOL_SPECS } from '#adapters/core/scratch-store/index.js';
import { WORKSPACE_READ_TOOL_SPECS } from '#adapters/core/workspace-read/index.js';
import { WORKSPACE_EDIT_TOOL_SPECS, WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/core/workspace-write/index.js';
import { FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES, FIRST_RUN_SCRATCH_WRITE_OPERATION_ID,
  FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID } from '#engine/core/installation/index.js';

// SCR-A × SCR-B integration (2026-09-28): the first-run template names tools and operations as data (engine may not import the
// adapters that define them). A rename on either side would silently turn a template `allow` into an ask/deny, so the names are
// pinned here against the real tool specs and Core operation descriptors.
const names = (specs: readonly { name: string }[]) => specs.map(spec => spec.name);

describe('first-run policy template names match the Core tool and operation catalog', () => {
  it('every template tool name is a real agent tool of its class', () => {
    expect(names(WORKSPACE_READ_TOOL_SPECS)).toEqual(expect.arrayContaining([...FIRST_RUN_READ_TOOL_NAMES]));
    expect(names(SCRATCH_TOOL_SPECS)).toEqual([...FIRST_RUN_SCRATCH_TOOL_NAMES]);
    expect([...names(WORKSPACE_EDIT_TOOL_SPECS), RUN_SHELL_TOOL_SPEC.name]).toEqual(expect.arrayContaining([...FIRST_RUN_EDIT_SHELL_TOOL_NAMES]));
  });

  it('every template operation id is the id of a Core operation descriptor', () => {
    expect(FIRST_RUN_WRITE_OPERATION_ID).toBe(WORKSPACE_FILE_WRITE_OPERATION.operation.id);
    expect(FIRST_RUN_SHELL_OPERATION_ID).toBe(HOST_SHELL_RUN_OPERATION.operation.id);
    expect(FIRST_RUN_SCRATCH_WRITE_OPERATION_ID).toBe(SCRATCH_FILE_WRITE_OPERATION.operation.id);
  });
});
