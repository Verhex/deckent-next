export type { FolderFacts, FirstTaskIntent, OnboardingSnapshot, OnboardingPort, OnboardingStep, OnboardingPresentation, OnboardingUi } from './internal/contract.js';
export { intentCommand } from './internal/contract.js';
export { FirstTaskRegistry, firstTaskIntent, type FirstTaskSuggestion } from './internal/first-tasks.js';
export { deferredOnboardingNotice, onboardingSteps, firstSignedInHost, createOnboardingSession } from './internal/session.js';
/** Remain Ink-free until the actual attested rich-terminal mount. */
export const loadOnboardingScreens = () => import('./internal/screens.js');
export const loadOnboardingProvider = () => import('./internal/provider.js');
export type { OnboardingHandoff } from './internal/handoff.js';
// Loaded with the rich Workline only; the index remains Ink-free for plain CLI startup.
export { useOnboardingHandoff } from './internal/handoff.js';

export { parseTerminalLaunch } from './internal/launch.js';

export { guideQuestion } from './internal/guides.js';
export { settleOnboardingReady } from './internal/ready.js';

export { workerImageQuestion, workerImageProgress } from './internal/worker-image.js';
