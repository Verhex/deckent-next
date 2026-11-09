import { relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { dist, reachGraph } from '../../fixtures/static-graph.js';

// The SDK entry (and every process that loads composition: runtime service, workers) must not load the surface layer (Ink/React)
// at runtime. A value import of `#surfaces/index.js` inside composition pulled the whole surfaces barrel into the SDK graph and made
// process tests ~25% slower (COMPOSITION-BUDGET follow-up).
it('the SDK entry reaches no surface module and neither Ink nor React, statically or through a lazy import', async () => {
  const graph = await reachGraph(resolve(dist, 'index.js'), { dynamic: true });
  const surfaces = [...graph.files].filter(file => relative(dist, file).startsWith('surfaces/'));
  expect(surfaces.map(graph.chain)).toEqual([]);
  expect([...graph.packages.keys()].filter(name => name === 'ink' || name === 'react')).toEqual([]);
  // The walk really covers composition's runtime service and the agent turn it serves. Since COMPOSITION-BUDGET-2 the turn reads the
  // OpenAI wire shape from its adapter, so the terminal chat stream is no longer on this path at all.
  expect(graph.files.has(resolve(dist, 'composition/core/agent-turn/internal/turn.js'))).toBe(true);
  expect(graph.files.has(resolve(dist, 'adapters/core/provider-openai-chat/internal/invocation.js'))).toBe(true);
});
