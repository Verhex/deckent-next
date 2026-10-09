import { changeConfiguredMcpCapabilities, configuredApproval, configuredPolicyTemplateUpgrade } from '../../dist/composition/core/approvals/index.js';

// Uses the built product composition, with a real terminal and an isolated fixture root.
const [root, encoded] = process.argv.slice(2), { operation, scopeId, input } = JSON.parse(encoded);
try {
  const result = operation === 'policy-upgrade' ? await configuredPolicyTemplateUpgrade(root, scopeId, {}, input)
    : operation === 'mcp-capability' ? await changeConfiguredMcpCapabilities(root, input)
    : await configuredApproval(root, 'decide', input);
  process.stderr.write(JSON.stringify({ response: { ok: true, result } }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ response: { ok: false, error: { code: error.code ?? 'fixture-failed' } } }) + '\n');
}
