import { DatabaseSync } from 'node:sqlite';
import { agentStandingSchema, encodeCommandProjection, type AgentStanding } from '#domain/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

/** The catalog store's row seal (test-owned integrity key): S8-4 promotion cards do not exist yet, so a test writes a standing the way the store
 * seals it. Keeps the current row and its history row in step, as the store does. */
const seal = (integrity: IntegrityAuthority, value: unknown) => JSON.stringify({ value, keyId: integrity.keyId, mac: integrity.sign(encodeCommandProjection('agent-catalog-store:1', value)) });
export function writeStanding(path: string, integrity: IntegrityAuthority, input: AgentStanding): AgentStanding {
  const row = agentStandingSchema.parse(input), db = new DatabaseSync(path);
  try {
    const record = seal(integrity, row);
    db.prepare('INSERT INTO agent_standings(scope_id,agent_id,revision,work_class,standing,standing_revision,record) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_id,agent_id,revision,work_class) DO UPDATE SET standing=excluded.standing,standing_revision=excluded.standing_revision,record=excluded.record')
      .run(row.scopeId, row.agentId, row.revision, row.workClass, row.standing, row.standingRevision, record);
    db.prepare('INSERT INTO agent_standing_revisions(scope_id,agent_id,revision,work_class,standing_revision,record) VALUES(?,?,?,?,?,?)')
      .run(row.scopeId, row.agentId, row.revision, row.workClass, row.standingRevision, record);
    return row;
  } finally { db.close(); }
}
/** The next standing of `row` as a person card would write it (S8-4); only for tests that need a promoted, narrowed or retired row. */
export const moved = (row: AgentStanding, standing: AgentStanding['standing']): AgentStanding => agentStandingSchema.parse({ ...row, standing,
  standingRevision: row.standingRevision + 1, basis: { kind: 'person-card', decidedBy: { issuer: 'local-os', subject: 'uid:1000', ai: false }, atMs: 9, commandId: `card-${standing}`, suggestionId: null, reasonCode: null } });
/** Re-seals one stored skill revision with other text but its old pin: a corrupted catalog the admission re-digest must refuse (N17). */
export function tamperSkillRevision(path: string, integrity: IntegrityAuthority, skillId: string, revision: number, text: string): void {
  const db = new DatabaseSync(path);
  try {
    const stored = JSON.parse(String(db.prepare('SELECT record FROM skill_definition_revisions WHERE skill_id=? AND revision=?').get(skillId, revision)!['record'])) as { value: { content: { text: string } } };
    const value = { ...stored.value, content: { ...stored.value.content, text } };
    db.exec('DROP TRIGGER skill_definition_revisions_no_update');
    db.prepare('UPDATE skill_definition_revisions SET record=? WHERE skill_id=? AND revision=?').run(seal(integrity, value), skillId, revision);
  } finally { db.close(); }
}
