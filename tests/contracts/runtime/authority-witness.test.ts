import { describe, expect, it } from 'vitest';
import { RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS, RUNTIME_SERVICE_PERSON_WRITE_OPERATIONS, assertAuthorityWitness, requireAuthorityWitness, runtimeServiceOperationSchema } from '#engine/index.js';

// SEC-1 (owner A48-D5): the engine contract alone — which operations need the witness, that the MCP actor never passes, and that every other
// operation is untouched (the witness is not even asked).
const witness = (answer: boolean) => { let asked = 0; return { port: { attest: async () => { asked++; return answer; } }, asked: () => asked }; };

describe('authority witness contract (SEC-1)', () => {
  it('names exactly the four authority writes', () => {
    expect([...RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS].sort()).toEqual(['deleteSecret', 'setPermissionMode', 'setSecret', 'switchSecretStore']);
  });
  it('an authority write passes only with the witness; the MCP actor is refused even with it', async () => {
    for (const operation of RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS) {
      await expect(requireAuthorityWitness(operation, undefined, witness(true).port)).resolves.toBeUndefined();
      await expect(requireAuthorityWitness(operation, undefined, witness(false).port)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation } });
      await expect(requireAuthorityWitness(operation, 'mcp', witness(true).port)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    }
  });
  it('every other operation is unchanged: no refusal and the witness is never asked', async () => {
    for (const operation of runtimeServiceOperationSchema.options.filter(name => !RUNTIME_SERVICE_AUTHORITY_WRITE_OPERATIONS.includes(name))) {
      const probe = witness(false);
      await expect(requireAuthorityWitness(operation, 'mcp', probe.port)).resolves.toBeUndefined();
      expect(probe.asked()).toBe(0);
    }
  });
  // S-05 (owner GO 2026-10-27, law audit K1/K2): a budget change or held-spend reconciliation needs the person's witness from every non-MCP
  // caller; the MCP actor is not refused here (its policy grant decides) and its witness is never asked.
  it('NEGATIVE: a spend change off MCP is refused without the witness and passes with it; MCP is left to policy', async () => {
    expect([...RUNTIME_SERVICE_PERSON_WRITE_OPERATIONS]).toEqual(['manageProviderSpend']);
    await expect(requireAuthorityWitness('manageProviderSpend', undefined, witness(false).port)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'manageProviderSpend' } });
    await expect(requireAuthorityWitness('manageProviderSpend', undefined, witness(true).port)).resolves.toBeUndefined();
    const mcp = witness(false);
    await expect(requireAuthorityWitness('manageProviderSpend', 'mcp', mcp.port)).resolves.toBeUndefined(); expect(mcp.asked()).toBe(0);
  });
  it('the same assertion serves any other authority write (MCP server trust): witness required, MCP actor refused', async () => {
    await expect(assertAuthorityWitness('mcpTrust', undefined, witness(true).port)).resolves.toBeUndefined();
    await expect(assertAuthorityWitness('mcpTrust', undefined, witness(false).port)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED', params: { operation: 'mcpTrust' } });
    const probe = witness(true);
    await expect(assertAuthorityWitness('mcpTrust', 'mcp', probe.port)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(probe.asked()).toBe(0);
  });
});
