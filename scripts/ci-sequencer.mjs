import { BaseSequencer } from 'vitest/node';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileIdentity, inventoryDigest, partitionTests } from './ci-test-plan.mjs';

const durations = JSON.parse(readFileSync(new URL('./ci-test-durations.json', import.meta.url), 'utf8')).durationMs;
export default class DurationSequencer extends BaseSequencer {
  async shard(specifications) {
    const { index, count } = this.ctx.config.shard;
    const root = this.ctx.config.root;
    const file = specification => fileIdentity(relative(root, specification.moduleId));
    const inventory = specifications.map(file).sort();
    const plan = partitionTests(inventory, durations, count);
    const selected = new Set(plan[index - 1].files);
    if (process.env.DECKENT_CI_EVIDENCE_DIR) {
      writeFileSync(join(process.env.DECKENT_CI_EVIDENCE_DIR, 'assignment.json'), JSON.stringify({ index, count,
        inventoryDigest: inventoryDigest(inventory), files: [...selected].sort(), estimatedDurationMs: plan[index - 1].durationMs }) + '\n');
    }
    return specifications.filter(specification => selected.has(file(specification)));
  }
  async sort(specifications) {
    // Expensive files start first so a late single file cannot strand the shard.
    return [...specifications].sort((a, b) => (durations[fileIdentity(relative(this.ctx.config.root, b.moduleId))] ?? 1000)
      - (durations[fileIdentity(relative(this.ctx.config.root, a.moduleId))] ?? 1000) || a.moduleId.localeCompare(b.moduleId, 'en'));
  }
}
