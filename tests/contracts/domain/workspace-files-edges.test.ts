import { describe, expect, it } from 'vitest';
import { WORKSPACE_ATTACHMENT_MAX_BYTES, WORKSPACE_FILE_FIND_MAX_RESULTS, WORKSPACE_FILE_QUERY_MAX_CHARS, parseWorkspaceAttachmentRequest,
  parseWorkspaceFileQuery, workspaceAttachmentSchema, workspaceFileMatchesSchema, workspaceFileQuerySchema } from '#domain/index.js';

const base = { schemaVersion: 1, scopeId: 'scope-1', query: 'src', limit: 5 };
const issues = (value: unknown) => {
  const result = workspaceFileQuerySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(i => `${i.path.join('.')}:${i.code}`);
};

describe('workspace file query edges', () => {
  it('pins the documented limits', () => {
    expect([WORKSPACE_FILE_QUERY_MAX_CHARS, WORKSPACE_FILE_FIND_MAX_RESULTS, WORKSPACE_ATTACHMENT_MAX_BYTES]).toEqual([256, 50, 32_768]);
  });
  it('accepts the query length boundary and the empty query, refuses one over', () => {
    expect(parseWorkspaceFileQuery({ ...base, query: '' }).query).toBe('');
    expect(parseWorkspaceFileQuery({ ...base, query: 'a'.repeat(256) }).query).toHaveLength(256);
    expect(issues({ ...base, query: 'a'.repeat(257) })).toEqual(['query:too_big']);
  });
  it('accepts limit 1 and 50, refuses 0 and 51', () => {
    expect(parseWorkspaceFileQuery({ ...base, limit: 1 }).limit).toBe(1);
    expect(parseWorkspaceFileQuery({ ...base, limit: 50 }).limit).toBe(50);
    expect(issues({ ...base, limit: 0 })).toEqual(['limit:too_small']);
    expect(issues({ ...base, limit: 51 })).toEqual(['limit:too_big']);
  });
  it('refuses fractional, non-numeric and non-finite limits', () => {
    expect(issues({ ...base, limit: 1.5 })).toEqual(['limit:invalid_type']);
    expect(issues({ ...base, limit: '5' })).toEqual(['limit:invalid_type']);
    expect(issues({ ...base, limit: Number.NaN })).toEqual(['limit:invalid_type']);
  });
  it('refuses unknown keys and a wrong schemaVersion', () => {
    expect(issues({ ...base, extra: 1 })).toEqual([':unrecognized_keys']);
    expect(issues({ ...base, schemaVersion: 2 })).toEqual(['schemaVersion:invalid_literal']);
  });
  it('refuses malformed scope ids', () => {
    for (const scopeId of ['', ' x', 'x ', 'a\nb', 'a\u007fb']) expect(issues({ ...base, scopeId }).length).toBeGreaterThan(0);
  });
  it('returns a readonly (frozen) parse result and throws from the parse helper', () => {
    expect(Object.isFrozen(parseWorkspaceFileQuery(base))).toBe(true);
    expect(() => parseWorkspaceFileQuery(null)).toThrow();
  });
});

describe('workspace attachment edges', () => {
  it('bounds maxBytes and path in the attachment request', () => {
    const req = { schemaVersion: 1, scopeId: 's', path: 'a.ts', maxBytes: 32_768 };
    expect(parseWorkspaceAttachmentRequest(req).maxBytes).toBe(32_768);
    expect(() => parseWorkspaceAttachmentRequest({ ...req, maxBytes: 32_769 })).toThrow();
    expect(() => parseWorkspaceAttachmentRequest({ ...req, maxBytes: 0 })).toThrow();
    expect(() => parseWorkspaceAttachmentRequest({ ...req, path: '' })).toThrow();
    expect(() => parseWorkspaceAttachmentRequest({ ...req, path: 'p'.repeat(4_097) })).toThrow();
  });
  it('caps matches at the result limit and refuses unknown refusal reasons', () => {
    const m = (n: number) => ({ schemaVersion: 1, paths: Array.from({ length: n }, (_, i) => `f${i}`), truncated: false, incomplete: false });
    expect(workspaceFileMatchesSchema.safeParse(m(50)).success).toBe(true);
    expect(workspaceFileMatchesSchema.safeParse(m(51)).success).toBe(false);
    expect(workspaceAttachmentSchema.safeParse({ schemaVersion: 1, path: 'a', status: 'refused', reason: 'nope' }).success).toBe(false);
    expect(workspaceAttachmentSchema.safeParse({ schemaVersion: 1, path: 'a', status: 'attached', content: '', bytes: 32_769, totalBytes: 40_000, truncated: true }).success).toBe(false);
  });
});
