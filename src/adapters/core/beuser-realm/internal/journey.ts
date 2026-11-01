import personas from '../../../../../assets/beuser/personas.json' with { type: 'json' };
import { beuserSealedRubricSchema } from '#domain/index.js';
import { BEUSER_ARRANGE_REGISTRY, BEUSER_LIMITS_REGISTRY, pinBeuserWalkerSummary, BeuserContractError } from '#engine/index.js';
import { beuserTerminalFixture } from '#adapters/core/beuser-surface/index.js';
import { sha256 } from '#platform/index.js';

/** Package readiness only: models, realm reachability and a completed journey are separate gates. */
export async function inspectPackagedBeuserJourney(journey: {
  journeyId: string; limitsProfile: string; branches: { id: string; personaIds: string[]; goal: Record<string, string> }[];
  rubric: { parameters: { branches: { id: string; initialStates: string[]; probeSet: string }[]; probeSets: { id: string; probes: unknown[] }[] } };
}) {
  const rubric = beuserSealedRubricSchema.parse(journey.rubric);
  const invalid = () => { throw new BeuserContractError('BEUSER_INPUT_INVALID'); };
  if (rubric.journeyId !== journey.journeyId || rubric.digest !== sha256(JSON.stringify(rubric.parameters))
    || !BEUSER_LIMITS_REGISTRY.profiles.some(row => row.revision === journey.limitsProfile)
    || !journey.branches.length || new Set(journey.branches.map(row => row.id)).size !== journey.branches.length
    || JSON.stringify(journey.branches.map(row => row.id)) !== JSON.stringify(journey.rubric.parameters.branches.map(row => row.id))) invalid();
  for (const branch of journey.branches) {
    for (const id of branch.personaIds) {
      const person = personas.personas.find(row => row.personaId === id); if (!person) return invalid();
      pinBeuserWalkerSummary({ ...person, journeyId: journey.journeyId, goal: branch.goal[person.language] });
    }
    const control = journey.rubric.parameters.branches.find(row => row.id === branch.id);
    if (!control || !branch.personaIds.length || !journey.rubric.parameters.probeSets.some(row => row.id === control.probeSet && row.probes.length)
      || control.initialStates.some(id => !BEUSER_ARRANGE_REGISTRY.states.some(state => state.id === id))) return invalid();
    beuserTerminalFixture(rubric.parameters, control.initialStates);
  }
  return { ready: true as const, journeyId: journey.journeyId, branchCount: journey.branches.length, rubricDigest: rubric.digest,
    evidenceClass: 'package-assets-only' as const };
}
