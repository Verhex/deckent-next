/** PLAN §1 / design-d4 §11. This scaffold cannot award acceptance; the assembled PTY walk supplies evidence later. */
const surfaces = [
  ['01', '/provider: person witness, connect and consent readback', 'K3/K7/K13'],
  ['02', '/model: channel, next-turn pin, active/default distinction', 'K7/K13'],
  ['03', 'Welcome: explain/scan/first work, preserve typed input', 'K9/K13'],
  ['04', 'Text chat: answer, usage and durable turn receipt', 'K2/K3/K11'],
  ['05', 'Read: exact content and out-of-scope refusal', 'K4/K11/K15'],
  ['06', 'Write: exact approval, readback and zero effect on denial', 'K4/K11/K15'],
  ['07', 'Shell: sandbox effect and protected-target refusal', 'K4/K11/K15'],
  ['08', 'Worker: Attempt-bound result/effect, no credential projection', 'K5/K6/K12'],
  ['09', 'Brain: role/consent gate and existing plan admission', 'K5/K8'],
  ['10', 'Agent: version/digest bound to work, no authority expansion', 'K5/K8/K13'],
  ['11', 'Skill: source/tools, explicit use, no unauthorized effect', 'K5/K8/K13'],
  ['12', 'Approval/cancel/recovery: expiry, replay, scope and unknown effects', 'K1/K4/K5/K11'],
] as const;
const subscriptions = [{ suffix: 'C', cli: 'claude' }, { suffix: 'G', cli: 'codex' }] as const;

export function a0AcceptanceMatrix() {
  return surfaces.flatMap(([number, criterion, dependencies]) => subscriptions.map(({ suffix, cli }) => ({
    id: `F${number}-${suffix}`, cli, criterion, dependencies,
    state: 'UNWALKED' as const,
    reason: 'Assembled driver/facade, compiled Deckent, disposable install and witnessed PTY walk not supplied to this scaffold.',
    evidence: [] as string[],
    security: {
      approveCardThenAssert: true,
      preserveRiskyRequest: true,
      assertProtectedTargetHash: true,
      requesterIsAi: true,
      deciderIsWitnessedPerson: true,
    },
  })));
}
