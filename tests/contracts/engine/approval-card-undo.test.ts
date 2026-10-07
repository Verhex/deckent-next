import { describe, expect, it } from 'vitest';
import { agentToolUndo } from '#engine/index.js';

describe('approval card undo word (T2-FOLLOWUP REVERSIBILITY)', () => {
  it('never says reversible: edit unverified, shell may change, destructive irreversible, fetch and read change nothing, MCP as declared', () => {
    expect(agentToolUndo('edit', 'edit')).toBe('unverified');
    expect(agentToolUndo('edit', 'edit-floor')).toBe('unverified');
    expect(agentToolUndo('shell', 'shell-other-modify')).toBe('may-change');
    expect(agentToolUndo('shell', 'shell-destructive')).toBe('irreversible');
    expect(agentToolUndo('fetch', 'fetch-unlisted')).toBe('no-change');
    expect(agentToolUndo('read', null)).toBe('no-change');
    expect(agentToolUndo('mcp', 'mcp-call', { readOnly: true, destructive: true })).toBe('server-read-only');
    expect(agentToolUndo('mcp', 'mcp-floor', { destructive: true })).toBe('server-destructive');
    expect(agentToolUndo('mcp', 'mcp-call', { readOnly: false, destructive: false })).toBe('server-additive');
    expect(agentToolUndo('mcp', 'mcp-call', {})).toBe('server-silent');
    expect(agentToolUndo('mcp', 'mcp-call', null)).toBe('server-silent');
  });
});
