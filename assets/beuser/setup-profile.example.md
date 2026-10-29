# B1 onboarding execution profile example

This example selects the installed `onboarding` journey and `ayse` persona. It is
provisional, uncalibrated preparation data, not evidence that a journey passed.
It creates an ordinary admission JSON document for `deckent beuser setup`.
Candidate paths and manifests depend on the exact installed package: generate
the document outside the package after building, rather than shipping host paths
or fabricated hashes. Regenerate it whenever the candidate changes.

Run the following from the built Deckent package directory. Supply the candidate
directory, a new output filename, the walker's channel/model, the evaluator's
channel/model, the C7-observed target environment SHA-256, and a JSON file listing
the candidate's actual contributor maker records. Those inputs contain references
only, never keys or credentials. Choose existing, active roles using
`deckent models roles` and `deckent models list`; this example creates no roles,
activation, spend account, permissions or execution configuration.

```sh
node --input-type=module - "$candidate" "$profile" "$walker_channel" "$walker_model" \
  "$evaluator_channel" "$evaluator_model" "$environment_digest" "$contributors" <<'JS'
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { measureInstalledPackage } from './dist/adapters/index.js';
import { beuserPersonaDigest, BEUSER_LIMITS_REGISTRY } from './dist/engine/index.js';
import { beuserDigest } from './dist/capabilities/index.js';
import { CONFIG_FIELDS, getConfigFieldDefault, sha256 } from './dist/platform/index.js';
const [candidate, output, walkerChannel, walkerModel, evaluatorChannel, evaluatorModel,
  environmentDigest, contributors] = process.argv.slice(2);
if (!candidate || !output || !walkerChannel || !walkerModel || !evaluatorChannel ||
  !evaluatorModel || !/^[a-f0-9]{64}$/u.test(environmentDigest ?? '') || !contributors)
  throw new Error('Supply all eight documented inputs');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const journey = await json('assets/beuser/journeys/onboarding.json');
const personas = await json('assets/beuser/personas.json');
const summary = personas.personas.find(row => row.personaId === 'ayse');
if (!summary || summary.journeyId !== journey.journeyId) throw new Error('Installed references differ');
const calibration = (await json('assets/beuser/calibration/manifest.json')).calibration;
const limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === journey.limitsProfile);
if (!limits?.provisional) throw new Error('Review this example against the installed limits');
const candidateRoot = await realpath(candidate);
const measured = await measureInstalledPackage(candidateRoot, getConfigFieldDefault('installation').packageMeasurement);
if (measured.declaredMissing.length) throw new Error('Incomplete candidate package');
const files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
const binding = { schemaVersion: 1,
  identity: { scopeId: 'pending-admission', runId: 'pending-admission', taskId: 'ayse',
    attemptId: 'pending-admission', layoutRevision: 'pending-admission', generation: 1 },
  candidate: { adapter: 'installed-package', version: measured.packageVersion, evidenceRef: 'c7-candidate',
    stateDigest: sha256(JSON.stringify(files)), environmentDigest },
  candidateDigest: measured.measurementDigest, personaDigest: beuserPersonaDigest(summary),
  journeyDigest: beuserDigest(journey), rubricDigest: journey.rubric.digest,
  realmId: 'pending-admission', nonce: randomUUID(), transcriptId: 'pending-admission' };
const parameters = { schemaVersion: 1, binding, summary, limitsRevision: limits.revision,
  candidateRoot, packageDigest: measured.measurementDigest, files,
  size: { columns: 100, rows: 30, scrollback: 1000 },
  bounds: { quietMs: 100, inactivityMs: 1000, maxInputBytes: 4096 }, completionTokens: 4096,
  rubric: journey.rubric,
  choices: { 'beuser-walker': { channelId: walkerChannel, modelId: walkerModel },
    'beuser-evaluator': { channelId: evaluatorChannel, modelId: evaluatorModel } },
  contributorModels: await json(contributors),
  entry: { mode: 'pty', nodeExecutable: process.execPath, args: [] },
  probes: [{ id: 'installation', dimension: 'outcome', readbackRef: 'c7-final-installation',
    key: 'installation', expected: 'installed' }], calibration };
const admission = CONFIG_FIELDS.admission.schema.parse({ poolId: 'beuser-b1-example',
  executionSlots: 1, inFlightSlots: 1, ordering: 'input-order',
  registry: { schemaVersion: 1, revision: 'b1-onboarding-example-1',
    profiles: [{ id: 'ayse', version: 1, adapter: { id: 'beuser', version: 1 }, parameters }],
    kinds: [{ kind: 'onboarding', profile: { id: 'ayse', version: 1 }, workspaceDelivery: 'none' }],
    evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } });
await writeFile(output, JSON.stringify(admission, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
JS
```

The screen size, timing, completion-token and one-slot pool values above are
finite example choices, not measured capacity or product defaults. The installed
limits remain authoritative. Admission replaces the pending identity fields with
fresh scope/Run/Task/Attempt, realm, nonce and transcript identities.
`process.execPath` must also exist in the isolated realm; select the C7 runtime
accordingly. No host directory is mounted through that value.

On the controller's person terminal, preview the resulting document with
`deckent beuser setup --profile "$profile" --scope "$scope" --json`, then use
the same command with `--apply` and approve its actual card. A different existing
registry is refused; this is a fresh-controller example. After setup,
`deckent beuser walk --journey onboarding --candidate "$candidate" --scope "$scope"`
uses the installed profile. Setup and dry admission do not prove model access,
spend authority, realm containment, cleanup, full onboarding or calibration.
This single persona and final installation probe leave other branches and durable
business milestones unproved; C7 must retain those gaps in its report.
