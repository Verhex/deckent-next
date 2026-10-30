import { readFile } from 'node:fs/promises';
import { openOnboardingDeferrals, readLocalOsIdentity } from '#adapters/index.js';
import { prepareProductFile, type ProductLayout } from '#platform/index.js';

// The presentation-only screens the onboarding session adds beside the setup stages (terminal-onboarding session/presentation).
const PRESENTATION = ['onboarding:budget', 'onboarding:worker-ready', 'permissions:start-mode', 'onboarding:first-task'];

/**
 * A terminal fixture that is not about first run: this OS user has already answered "Later" on every onboarding screen for `folder`
 * (canonical, relative to the installation root; '' is the root), written through the product's own deferral store. Later holds for the
 * model screen too (owner 2026-10-30); /setup reopens it.
 */
export async function settleOnboarding(layout: ProductLayout, folder = ''): Promise<void> {
  const stages = JSON.parse(await readFile(new URL('../../src/engine/core/setup/internal/stages.json', import.meta.url), 'utf8')) as { phases: Record<string, string> };
  const ids = [...Object.entries(stages.phases).filter(([, phase]) => phase === 'onboarding').map(([id]) => id), ...PRESENTATION];
  const { issuer, subject } = readLocalOsIdentity(), store = openOnboardingDeferrals(await prepareProductFile(layout, 'onboarding'));
  for (const stageId of ids) await store.defer({ principal: JSON.stringify([issuer, subject]), folder, stageId, deferredAt: 1, planDigest: '0'.repeat(64) });
}
