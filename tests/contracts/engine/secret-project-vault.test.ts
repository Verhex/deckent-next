import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DECK_FILE, PROJECT_VAULT, SecretGrantStoreRegistry, CORE_SECRET_GRANT_STORE_ID, assessProjectVaultOwnership, buildSecretInventory, credentialSourceError,
  decideCredentialSource, deckDeclaration, emptySecretGrantFile, parseDeckDeclarations, projectVaultAnchorSchema, projectVaultHandover, projectVaultKey,
  projectVaultRecordSchema, secretGrantFileSchema, type CredentialSourceInput, type ProjectVaultAnchor, type SecretGrantStoreFactory } from '#engine/index.js';
import { DeckentError, ErrorRegistry } from '#platform/index.js';

const code = (work: () => unknown) => { try { work(); } catch (error) { return (error as DeckentError).code; } return null; };
const params = (work: () => unknown) => { try { work(); } catch (error) { return (error as DeckentError).params; } return null; };
const location = (canonicalRoot: string, inode = '42') => ({ canonicalRoot, device: '2049', inode });
const anchorOf = (overrides: Partial<ProjectVaultAnchor> = {}): ProjectVaultAnchor => projectVaultAnchorSchema.parse({
  installationId: '7a0c3c4e-7c1f-4f7e-9d9b-2b6f5a1e0c11', projectId: '0b8e6f8e-3a52-4b38-9a34-8d1d8a2e9f02',
  binding: location('/home/u/proj/.deckent'), repository: location('/home/u/proj/.git', '43'), projectRoot: '/home/u/proj', ...overrides });

describe('.deck v1 (references only)', () => {
  it('parses the header and NAME=main|project entries; comments and blank lines are ignored', () => {
    const parsed = parseDeckDeclarations('# references only\r\nDECK_FORMAT=1\n\nDECKENT_ANTHROPIC_KEY=main\nOPENAI_API_KEY=project\n');
    expect([...parsed]).toEqual([['DECKENT_ANTHROPIC_KEY', 'main'], ['OPENAI_API_KEY', 'project']]);
    expect(deckDeclaration(parsed, 'OPENAI_API_KEY')).toBe('project');
    expect(deckDeclaration(parsed, 'OTHER')).toBe('undeclared');
    expect(deckDeclaration(null, 'OTHER')).toBe('undeclared');
  });
  it.each([
    ['missing header', 'A=main\n', 'header'],
    ['empty file', '# nothing\n', 'header'],
    ['wrong format version', 'DECK_FORMAT=2\nA=main\n', 'header'],
    ['aliasing', 'DECK_FORMAT=1\nA=main:OTHER\n', 'entry'],
    ['a value instead of a vault', 'DECK_FORMAT=1\nA=sk-ant-synthetic-canary\n', 'entry'],
    ['spaces around =', 'DECK_FORMAT=1\nA = main\n', 'entry'],
    ['lower-case name', 'DECK_FORMAT=1\nopenai=main\n', 'entry'],
    ['export prefix', 'DECK_FORMAT=1\nexport A=main\n', 'entry'],
    ['a name over the grammar bound', `DECK_FORMAT=1\n${'A'.repeat(129)}=main\n`, 'entry'],
    ['the reserved header name as an entry', 'DECK_FORMAT=1\nDECK_FORMAT=main\n', 'reserved-name'],
    ['a duplicate', 'DECK_FORMAT=1\nA=main\nA=project\n', 'duplicate'],
  ])('refuses the whole file on %s (fail closed, never echoing the line)', (_label, text, reason) => {
    expect(code(() => parseDeckDeclarations(text))).toBe('DECK_FILE_INVALID');
    const shown = params(() => parseDeckDeclarations(text));
    expect(shown?.['reason']).toBe(reason);
    expect(JSON.stringify(shown)).not.toContain('sk-ant');
    expect(ErrorRegistry.createError('DECK_FILE_INVALID', { params: shown ?? {} }).message).not.toContain('{');
  });
  it('enforces the registry byte and entry bounds', () => {
    expect(params(() => parseDeckDeclarations(`DECK_FORMAT=1\n# ${'x'.repeat(DECK_FILE.maxBytes)}\n`))?.['reason']).toBe('too-large');
    const many = Array.from({ length: DECK_FILE.maxEntries + 1 }, (_, index) => `K_${index}=main`).join('\n');
    expect(params(() => parseDeckDeclarations(`DECK_FORMAT=1\n${many}\n`))?.['reason']).toBe('too-many-entries');
    const full = Array.from({ length: DECK_FILE.maxEntries }, (_, index) => `K_${index}=main`).join('\n');
    expect(parseDeckDeclarations(`DECK_FORMAT=1\n${full}\n`).size).toBe(DECK_FILE.maxEntries);
  });
});

describe('credential source decision', () => {
  const cases: readonly (readonly [string, CredentialSourceInput, string])[] = [
    ['no project identity', { identified: false, declaration: 'project', projectHas: true, granted: true }, 'SECRET_PROJECT_IDENTITY_REQUIRED'],
    ['declared project, present', { identified: true, declaration: 'project', projectHas: true, granted: false }, 'project'],
    ['declared project, absent: never falls to main', { identified: true, declaration: 'project', projectHas: false, granted: true }, 'SECRET_PROJECT_MISSING'],
    ['undeclared but in the project vault: no shadowing', { identified: true, declaration: 'undeclared', projectHas: true, granted: true }, 'DECK_DECLARATION_REQUIRED'],
    ['undeclared, granted: main', { identified: true, declaration: 'undeclared', projectHas: false, granted: true }, 'main'],
    ['undeclared, no grant', { identified: true, declaration: 'undeclared', projectHas: false, granted: false }, 'SECRET_GRANT_REQUIRED'],
    ['declared main, granted', { identified: true, declaration: 'main', projectHas: true, granted: true }, 'main'],
    ['declared main, no grant: .deck alone never grants', { identified: true, declaration: 'main', projectHas: false, granted: false }, 'SECRET_GRANT_REQUIRED'],
  ];
  it.each(cases)('%s', (_label, input, expected) => {
    const decision = decideCredentialSource(input);
    expect(decision.source === 'refused' ? decision.code : decision.source).toBe(expected);
  });
  it('a refusal names the secret, the project and the exact next command, never a value', () => {
    const error = credentialSourceError('SECRET_GRANT_REQUIRED', { name: 'DECKENT_ANTHROPIC_KEY', project: '/home/u/proj', scopeId: 'local' });
    expect(error.code).toBe('SECRET_GRANT_REQUIRED');
    expect(error.suggestion).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope local');
    for (const refusal of ['SECRET_PROJECT_MISSING', 'DECK_DECLARATION_REQUIRED', 'SECRET_PROJECT_IDENTITY_REQUIRED'] as const) {
      const shown = credentialSourceError(refusal, { name: 'OPENAI_API_KEY', project: '/home/u/proj', scopeId: 'local' });
      expect(`${shown.message} ${shown.suggestion ?? ''}`).not.toMatch(/\{\w+\}/u);
    }
  });
});

describe('project vault identity and ownership', () => {
  it('keys the vault by installation and project identity under a versioned salt, never by a path', () => {
    const anchor = anchorOf(), moved = anchorOf({ binding: location('/srv/proj/.deckent', '7'), projectRoot: '/srv/proj' });
    expect(projectVaultKey(anchor)).toMatch(/^[a-f0-9]{64}$/u);
    expect(projectVaultKey(moved)).toBe(projectVaultKey(anchor));
    expect(projectVaultKey(anchorOf({ projectId: randomUUID() as ProjectVaultAnchor['projectId'] }))).not.toBe(projectVaultKey(anchor));
    expect(PROJECT_VAULT.keySalt).toBe('deckent.project-secrets/v1');
  });
  it('a copy (same identities, another data root) or another repository is claimed; the owner matches', () => {
    const record = projectVaultRecordSchema.parse({ schemaVersion: 1, anchor: anchorOf(), firstSeenAtMs: 1, handedOverAtMs: null });
    expect(assessProjectVaultOwnership(record, anchorOf())).toBe('match');
    expect(assessProjectVaultOwnership(record, anchorOf({ binding: location('/home/u/copy/.deckent', '99'), projectRoot: '/home/u/copy' }))).toBe('claimed');
    expect(assessProjectVaultOwnership(record, anchorOf({ binding: location('/home/u/proj/.deckent', '100') }))).toBe('claimed');
    expect(assessProjectVaultOwnership(record, anchorOf({ repository: location('/home/u/copy/.git', '101') }))).toBe('claimed');
    expect(assessProjectVaultOwnership(record, anchorOf({ repository: null }))).toBe('claimed');
  });
  it('hands over only after a move (the recorded owner is gone), never to a copy while the original exists', () => {
    const record = projectVaultRecordSchema.parse({ schemaVersion: 1, anchor: anchorOf(), firstSeenAtMs: 1, handedOverAtMs: null });
    const moved = anchorOf({ binding: location('/srv/proj/.deckent', '7'), repository: location('/srv/proj/.git', '8'), projectRoot: '/srv/proj' });
    expect(code(() => projectVaultHandover(record, moved, true, 5))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
    expect(code(() => projectVaultHandover(record, anchorOf({ ...moved, installationId: randomUUID() as ProjectVaultAnchor['installationId'] }), false, 5))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
    const handed = projectVaultHandover(record, moved, false, 5);
    expect(handed).toMatchObject({ anchor: { projectRoot: '/srv/proj' }, firstSeenAtMs: 1, handedOverAtMs: 5 });
    expect(assessProjectVaultOwnership(handed, moved)).toBe('match');
  });
});

describe('grant record and grant store registry', () => {
  const grant = { name: 'DECKENT_ANTHROPIC_KEY', scopeId: 'local', by: { issuer: 'host', subject: '1000' }, atMs: 1, source: 'card', decisionEventId: randomUUID() };
  it('a grant without its sealed decision event id, a duplicate name or a foreign field is invalid', () => {
    const base = { ...emptySecretGrantFile(anchorOf()), revision: 1 };
    expect(secretGrantFileSchema.safeParse({ ...base, grants: [grant] }).success).toBe(true);
    const unsealed: Record<string, unknown> = { ...grant }; delete unsealed['decisionEventId'];
    expect(secretGrantFileSchema.safeParse({ ...base, grants: [unsealed] }).success).toBe(false);
    expect(secretGrantFileSchema.safeParse({ ...base, grants: [grant, grant] }).success).toBe(false);
    expect(secretGrantFileSchema.safeParse({ ...base, grants: [{ ...grant, value: 'x' }] }).success).toBe(false);
    expect(secretGrantFileSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });
  it('Core owns core.*; Enterprise registers before the seal only', () => {
    const factory = (id: string): SecretGrantStoreFactory => ({ id, create: () => ({ id, read: async () => emptySecretGrantFile(anchorOf()), update: async () => emptySecretGrantFile(anchorOf()) }) });
    const registry = SecretGrantStoreRegistry.create([factory(CORE_SECRET_GRANT_STORE_ID)]);
    expect(() => registry.register(factory('core.secret-grant.other@1'))).toThrow();
    registry.register(factory('enterprise.secret-grant.central@1'));
    expect(registry.has('enterprise.secret-grant.central@1')).toBe(true);
    registry.seal();
    expect(() => registry.register(factory('enterprise.secret-grant.late@1'))).toThrow();
    expect(() => SecretGrantStoreRegistry.create([factory('enterprise.secret-grant.central@1')])).toThrow();
    expect(() => registry.open('enterprise.secret-grant.unknown@1', { root: '/r', anchor: anchorOf(), lockTimeoutMs: 1 })).toThrow();
    const liar = SecretGrantStoreRegistry.create([{ id: CORE_SECRET_GRANT_STORE_ID, create: () => factory('core.secret-grant.liar@1').create({ root: '/r', anchor: anchorOf(), lockTimeoutMs: 1 }) }]);
    expect(() => liar.open(CORE_SECRET_GRANT_STORE_ID, { root: '/r', anchor: anchorOf(), lockTimeoutMs: 1 })).toThrow();
  });
});

describe('secret inventory', () => {
  it('lists names, vaults, users, .deck, grant and presence, and the sync findings; never a value', () => {
    const grants = secretGrantFileSchema.parse({ ...emptySecretGrantFile(anchorOf()), revision: 1,
      grants: [{ name: 'DECKENT_ANTHROPIC_KEY', scopeId: 'local', by: { issuer: 'host', subject: '1000' }, atMs: 3, source: 'card', decisionEventId: 'e-1' }] });
    const other = secretGrantFileSchema.parse({ ...emptySecretGrantFile(anchorOf()), revision: 1,
      grants: [{ name: 'OPENAI_API_KEY', scopeId: 'local', by: { issuer: 'host', subject: '1000' }, atMs: 4, source: 'admin', decisionEventId: 'e-2' }] });
    const inventory = buildSecretInventory({
      mainNames: ['DECKENT_ANTHROPIC_KEY', 'OPENAI_API_KEY', 'BACKUP_PASSPHRASE'],
      references: [{ name: 'DECKENT_ANTHROPIC_KEY', usedBy: 'profile anthropic@1' }, { name: 'OPENAI_API_KEY', usedBy: 'profile openai@1' },
        { name: 'GLM_KEY', usedBy: 'profile glm@1' }, { name: 'STRAY_KEY', usedBy: 'profile stray@1' }],
      projects: [{ project: '/home/u/proj', names: ['GLM_KEY', 'STRAY_KEY', 'UNUSED_OWN'], grants, current: true,
        deck: parseDeckDeclarations('DECK_FORMAT=1\nGLM_KEY=project\nMISSING_OWN=project\nGONE_MAIN=main\n') },
      { project: '/home/u/other', names: ['THEIRS'], grants: other, deck: null, current: false }],
    });
    const row = (name: string, project: string | null = '/home/u/proj') => inventory.rows.find(entry => entry.name === name && entry.project === project);
    expect(row('DECKENT_ANTHROPIC_KEY')).toMatchObject({ vault: 'main', usedBy: ['profile anthropic@1'], deck: 'undeclared', grant: { state: 'granted', atMs: 3 }, presence: 'stored' });
    expect(row('OPENAI_API_KEY')).toMatchObject({ vault: 'main', grant: { state: 'none' } });
    expect(row('GLM_KEY')).toMatchObject({ vault: 'project', deck: 'project', grant: { state: 'not-applicable' }, presence: 'stored' });
    expect(row('MISSING_OWN')).toMatchObject({ vault: 'project', presence: 'missing' });
    expect(row('THEIRS', '/home/u/other')).toMatchObject({ vault: 'project', deck: null });
    expect(row('OPENAI_API_KEY', '/home/u/other')).toMatchObject({ vault: 'main', grant: { state: 'granted', atMs: 4 } });
    expect(inventory.findings).toEqual(expect.arrayContaining([
      { kind: 'grant-required', name: 'OPENAI_API_KEY', project: '/home/u/proj' },
      { kind: 'undeclared-project-key', name: 'STRAY_KEY', project: '/home/u/proj' },
      { kind: 'undeclared-project-key', name: 'UNUSED_OWN', project: '/home/u/proj' },
      { kind: 'declared-missing', name: 'MISSING_OWN', project: '/home/u/proj' },
      { kind: 'declared-missing', name: 'GONE_MAIN', project: '/home/u/proj' },
    ]));
    // A shadowing project key is reported as undeclared, not as a missing grant of the main key.
    expect(inventory.findings).not.toContainEqual({ kind: 'grant-required', name: 'STRAY_KEY', project: '/home/u/proj' });
  });
  it('a main vault that cannot enumerate is unverified, never guessed', () => {
    const inventory = buildSecretInventory({ mainNames: null, references: [{ name: 'K', usedBy: 'profile p@1' }],
      projects: [{ project: '/p', names: [], grants: null, deck: null, current: true }] });
    expect(inventory.rows).toEqual([expect.objectContaining({ name: 'K', vault: 'main', presence: 'unverified', grant: { state: 'none' } })]);
  });
});
