import { changeConfiguredMcpCapabilities, configuredApproval, configuredPolicyTemplateUpgrade } from '../../dist/composition/core/approvals/index.js';
import { configuredProjectInstructions } from '../../dist/composition/core/project-instructions/index.js';
import { projectSkeleton } from '../../dist/surfaces/core/project-instructions/index.js';

// Uses the built product composition, with a real terminal and an isolated fixture root.
const [root, encoded] = process.argv.slice(2), { operation, scopeId, input } = JSON.parse(encoded);
try {
  const initialize = async () => {
    const port = await configuredProjectInstructions(root);
    return port.initialize(await port.preview(input.bridges, projectSkeleton(input.locale)));
  };
  const result = operation === 'policy-upgrade' ? await configuredPolicyTemplateUpgrade(root, scopeId, {}, input)
    : operation === 'mcp-capability' ? await changeConfiguredMcpCapabilities(root, input)
    : operation === 'project-init' ? await initialize()
    : await configuredApproval(root, 'decide', input);
  process.stderr.write(JSON.stringify({ response: { ok: true, result } }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ response: { ok: false, error: { code: error.code ?? 'fixture-failed' } } }) + '\n');
}
