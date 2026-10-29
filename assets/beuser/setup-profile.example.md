# B1 execution profile example

This example builds one admission document for the installed journeys you name
(for example `onboarding,uninstall-v2,beuser-self`). For each journey it selects
the first rubric branch and its first persona, takes that branch's own probe set
from `rubric.parameters.probeSets`, and derives the profile v3 `startState` from
the installed arrange catalog (`assets/beuser/arrange.json`). It is provisional,
uncalibrated preparation data, not evidence that a journey passed. It creates an
ordinary admission JSON document for `deckent beuser setup`.
Candidate paths and manifests depend on the exact installed package: generate
the document outside the package after building, rather than shipping host paths
or fabricated hashes. Regenerate it whenever the candidate or the arrange catalog
revision changes. Profile v2 and v3 carry only the manifest SHA-256, full file count
and source/package identity. The complete staged `manifest.json` stays in the
candidate; setup, walk and realm admission reload and verify it. Inline v1 profiles
must be regenerated; no JSON limit is raised.

Run the following from the built Deckent package directory. Supply the candidate
directory, a new output filename, the walker's channel/model, the evaluator's
channel/model, the C7-observed target environment SHA-256, a JSON file listing
the candidate's actual contributor maker records and the comma-separated journey
ids. Those inputs contain references only, never keys or credentials. Choose
existing, active roles using `deckent models roles` and `deckent models list`; this
example creates no roles, activation, spend account, permissions or execution
configuration. The script prints, per journey, the branch's start states that the
catalog does not arrange; record them with the walk, because a walk does not prove
a start state it did not arrange and read back.

```sh
node --input-type=module - "$candidate" "$profile" "$walker_channel" "$walker_model" \
  "$evaluator_channel" "$evaluator_model" "$environment_digest" "$contributors" "$journeys" <<'JS'
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BEUSER_REALM_RECIPE, measureInstalledPackage } from './dist/adapters/index.js';
import { beuserPersonaDigest, BEUSER_LIMITS_REGISTRY, BEUSER_ARRANGE_REGISTRY } from './dist/engine/index.js';
import { beuserDigest } from './dist/capabilities/index.js';
import { CONFIG_FIELDS, getConfigFieldDefault, sha256 } from './dist/platform/index.js';
const [candidate, output, walkerChannel, walkerModel, evaluatorChannel, evaluatorModel,
  environmentDigest, contributors, journeyList] = process.argv.slice(2);
if (!candidate || !output || !walkerChannel || !walkerModel || !evaluatorChannel ||
  !evaluatorModel || !/^[a-f0-9]{64}$/u.test(environmentDigest ?? '') || !contributors || !journeyList)
  throw new Error('Supply all nine documented inputs');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const personas = (await json('assets/beuser/personas.json')).personas;
const calibration = (await json('assets/beuser/calibration/manifest.json')).calibration;
const candidateRoot = await realpath(candidate);
const measured = await measureInstalledPackage(candidateRoot, getConfigFieldDefault('installation').packageMeasurement);
if (measured.declaredMissing.length) throw new Error('Incomplete candidate package');
const release = await json(candidateRoot + '/release.json');
const manifest = measured.files.find(file => file.path === 'manifest.json');
if (!manifest) throw new Error('A staged candidate manifest is required');
const candidateManifest = { sha256: manifest.sha256, fileCount: measured.files.length,
  sourceCommit: release.sourceCommit, sourceTreeSha256: release.sourceTreeSha256, version: measured.packageVersion };
const files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
const contributorModels = await json(contributors), profiles = [], kinds = [], unarranged = {};
for (const journeyId of journeyList.split(',')) {
  const journey = await json(`assets/beuser/journeys/${journeyId}.json`);
  const branch = journey.rubric.parameters.branches[0], visible = journey.branches.find(row => row.id === branch?.id);
  const person = personas.find(row => row.personaId === visible?.personaIds[0]);
  const probeSet = journey.rubric.parameters.probeSets.find(row => row.id === branch?.probeSet);
  const limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === journey.limitsProfile);
  if (journey.journeyId !== journeyId || !person || !probeSet) throw new Error('Installed references differ');
  if (!limits?.provisional) throw new Error('Review this example against the installed limits');
  const summary = { ...person, journeyId, goal: visible.goal[person.language] };
  // Catalogued states contribute their steps once, in branch order; the rest stay named, never inferred.
  const states = branch.initialStates.map(id => BEUSER_ARRANGE_REGISTRY.states.find(row => row.id === id));
  const steps = [...new Map(states.flatMap(row => row?.steps ?? []).map(step => [`${step.id}@${step.version}`, step])).values()];
  unarranged[journeyId] = branch.initialStates.filter((_, index) => !states[index]?.steps);
  const binding = { schemaVersion: 1,
    identity: { scopeId: 'pending-admission', runId: 'pending-admission', taskId: `${person.personaId}-${journeyId}`,
      attemptId: 'pending-admission', layoutRevision: 'pending-admission', generation: 1 },
    candidate: { adapter: 'installed-package', version: measured.packageVersion, evidenceRef: 'c7-candidate',
      stateDigest: sha256(JSON.stringify(files)), environmentDigest },
    candidateDigest: measured.measurementDigest, personaDigest: beuserPersonaDigest(summary),
    journeyDigest: beuserDigest(journey), rubricDigest: journey.rubric.digest,
    realmId: 'pending-admission', nonce: randomUUID(), transcriptId: 'pending-admission' };
  const parameters = { schemaVersion: 3, binding, summary, limitsRevision: limits.revision,
    candidateRoot, packageDigest: measured.measurementDigest, candidateManifest,
    startState: { schemaVersion: 1, catalogRevision: BEUSER_ARRANGE_REGISTRY.revision, steps },
    size: { columns: 100, rows: 30, scrollback: 1000 },
    bounds: { quietMs: 100, inactivityMs: 1000, maxInputBytes: 4096 }, completionTokens: 4096,
    rubric: journey.rubric,
    choices: { 'beuser-walker': { channelId: walkerChannel, modelId: walkerModel },
      'beuser-evaluator': { channelId: evaluatorChannel, modelId: evaluatorModel } },
    contributorModels,
    entry: { mode: 'pty', nodeExecutable: BEUSER_REALM_RECIPE.nodeExecutable, args: [] },
    probes: probeSet.probes, calibration };
  const id = `${person.personaId}-${journeyId}`;
  profiles.push({ id, version: 1, adapter: { id: 'beuser', version: 1 }, parameters });
  kinds.push({ kind: journeyId, profile: { id, version: 1 }, workspaceDelivery: 'none' });
}
const admission = CONFIG_FIELDS.admission.schema.parse({ poolId: 'beuser-b1-example',
  executionSlots: 1, inFlightSlots: 1, ordering: 'input-order',
  registry: { schemaVersion: 1, revision: `b1-example-${journeyList.replaceAll(',', '-')}`, profiles, kinds,
    evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } });
await writeFile(output, JSON.stringify(admission, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ unarranged }));
JS
```

Every profile starts from its journey's first branch on the terminal (`pty`, no
arguments); its probes come from that branch's probe set, so probes the current
readback cannot observe stay unknown, never RED. The screen size, timing,
completion-token and one-slot pool values above are finite example choices, not measured capacity or product defaults. The installed
limits remain authoritative. Admission replaces the pending identity fields with
fresh scope/Run/Task/Attempt, realm, nonce and transcript identities.
The executable comes from the installed realm recipe, independently of the controller
runtime. Setup and admission refuse a different executable before any realm starts.

On the controller's person terminal, preview the resulting document with
`deckent beuser setup --profile "$profile" --scope "$scope" --json`, then use
the same command with `--apply` and approve its actual card. A different existing
registry is refused; this is a fresh-controller example. After setup,
`deckent beuser walk --journey <journey> --candidate "$candidate" --scope "$scope"`
uses the installed profile of that journey. Setup and dry admission do not prove model access,
spend authority, realm containment, cleanup, full onboarding or calibration.
One persona and branch per journey, the printed unarranged start states and the
installation-only readback leave other branches and durable business milestones
unproved; C7 must retain those gaps in its report.
