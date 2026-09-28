import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyPolicyTemplateInstallation, inspectPolicyTemplate, previewPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';

// SCR-B (owner 2026-09-28, checkpoint option B, proof/SCR-B-2026-09-28/review.md): a real journal + real adapters
// end to end. No Docker, no pool, no config.json is ever created or required for this path.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-policy-template-')); roots.push(root); return root; }

it('previews without touching disk, then a real apply journals and writes policy.json + bindings.json privately; a repeated apply is a byte-identical replay', async () => {
  const root = await project();
  const preview = await previewPolicyTemplateInstallation(root, 'installation');
  expect(preview).toMatchObject({ status: 'preview', scopeId: 'installation', template: { id: 'first-run-template', version: 1 } });
  await expect(stat(join(root, '.deckent'))).rejects.toMatchObject({ code: 'ENOENT' });
  const identity = readLocalOsIdentity();
  expect(preview.principal).toEqual({ issuer: identity.issuer, subject: identity.subject });
  expect(await inspectPolicyTemplate(root)).toBeNull(); // no policy file yet

  const result = await applyPolicyTemplateInstallation(root, 'installation');
  expect(result).toMatchObject({ status: 'installed', template: { id: 'first-run-template', version: 1 }, scopeId: 'installation' });
  const policyPath = join(root, '.deckent/policy.json'), bindingsPath = join(root, '.deckent/bindings.json');
  const policyBytes = await readFile(policyPath, 'utf8'), bindingsBytes = await readFile(bindingsPath, 'utf8');
  expect(JSON.parse(policyBytes)).toMatchObject({ schemaVersion: 2, revision: 'first-run-template-v1' });
  expect(JSON.parse(bindingsBytes)).toEqual({ schemaVersion: 1, revision: 'first-run-template-v1-bindings', bindings: [] });
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600); expect((await stat(bindingsPath)).mode & 0o777).toBe(0o600);

  expect(await inspectPolicyTemplate(root)).toEqual({ id: 'first-run-template', version: 1 });

  const replay = await applyPolicyTemplateInstallation(root, 'installation');
  expect(replay).toMatchObject({ status: 'replayed' });
  expect(await readFile(policyPath, 'utf8')).toBe(policyBytes);
  expect(await readFile(bindingsPath, 'utf8')).toBe(bindingsBytes);
});

it('never overwrites an existing, different policy.json: apply refuses before any journal entry, the file stays byte-identical, and doctor does not recognize it', async () => {
  const root = await project();
  await mkdir(join(root, '.deckent'), { mode: 0o700, recursive: true });
  const before = `${JSON.stringify({ schemaVersion: 1, revision: 'hand-authored', grants: [], restrictions: [] })}\n`;
  await writeFile(join(root, '.deckent/policy.json'), before, { mode: 0o600 });
  expect(await inspectPolicyTemplate(root)).toBeNull();

  await expect(applyPolicyTemplateInstallation(root, 'installation')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });

  expect(await readFile(join(root, '.deckent/policy.json'), 'utf8')).toBe(before);
  await expect(stat(join(root, '.deckent/bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(root, '.deckent/installation/journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await inspectPolicyTemplate(root)).toBeNull();
});

it('two different scopes cannot both occupy the same project\'s one installation journal', async () => {
  const root = await project();
  await applyPolicyTemplateInstallation(root, 'installation');
  await expect(applyPolicyTemplateInstallation(root, 'other-scope')).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
});
