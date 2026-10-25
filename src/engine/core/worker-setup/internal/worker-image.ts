import { ErrorRegistry } from '#platform/index.js';
import { insertHistoryLine, nextImageVersion, workerImageRecipeSchema } from '#engine/core/toolchain-currency/index.js';

/** What the person confirms before anything runs (the surface words it): build `imageVersion` from the installed package's recipe (`held`: the
 * newest revision the daemon already holds, which a build advances past), or adopt `imageId` (the builder's short check container, no network). */
export type WorkerImageCard = Readonly<{ mode: 'build'; imageVersion: string; held: string | null } | { mode: 'adopt'; imageVersion: string; imageId: string }>;
/** `present`: this installation already holds a receipt whose image the daemon has; nothing ran. */
export type WorkerImageStatus = 'present' | 'declined' | 'built' | 'adopted';
export type WorkerImageBuildInput = Readonly<{ imageVersion: string; recipe: unknown; dockerfile: string; imageId?: string }>;
/** The effects the first worker image needs; adapters hold the receipts, the installed builder and the daemon, the surface holds the card. */
export interface WorkerImagePorts {
  receipt(): Promise<Readonly<{ imageId: string; imageVersion: string }> | null>;
  sources(): Promise<Readonly<{ recipe: unknown; dockerfile: string }>>;
  held(): Promise<string | null>;
  confirm(card: WorkerImageCard): Promise<boolean>;
  build(input: WorkerImageBuildInput): Promise<unknown>;
}

const counter = (version: string) => Number(/^r([1-9][0-9]*)-/u.exec(version)?.[1] ?? 0);
const recipeOf = (input: unknown) => {
  const parsed = workerImageRecipeSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('WORKER_IMAGE_SOURCE_INVALID');
  return parsed.data;
};
/**
 * Pure: the first image of an installation (BR1, owner Q2 2026-10-23). The package's recipe as shipped while the daemon holds no revision at or
 * past it; otherwise the next counter past the daemon's, dated by the planning day, with its history line, the toolchain update's own rule
 * (ISCI-IMAJ-SAYAC: installations sharing a daemon share its tags). The builder still refuses a counter taken after this read.
 */
export function planFirstWorkerImage(input: Readonly<{ recipe: unknown; dockerfile: string; held: string | null; plannedAt: string }>): WorkerImageBuildInput {
  const recipe = recipeOf(input.recipe), current = recipe.imageVersion;
  if (!input.held || counter(input.held) < counter(current)) return { imageVersion: current, recipe, dockerfile: input.dockerfile };
  const imageVersion = nextImageVersion(current, input.plannedAt, input.held);
  const base = recipe.schemaVersion === 3 ? recipe.base.image : recipe.baseImage;
  const line = `# version ${imageVersion} | ${input.plannedAt.slice(0, 10)} | base ${base} | supersedes ${current} | first image of this installation (deckent init); counter past daemon-held ${input.held}`;
  return { imageVersion, recipe: recipe.schemaVersion === 3 ? recipe : { ...recipe, imageVersion, previousVersion: current }, dockerfile: insertHistoryLine(input.dockerfile, line) };
}

/**
 * The one owner of `deckent init`'s worker image (BR1): an existing receipt whose image is present ends it; otherwise the person sees the card
 * (version, size and time on the surface) and only a yes builds, or adopts an image the person named. The build's receipt is the only success
 * evidence, and the next state is never taken from this result but from the next observation (which then offers the execution settings).
 */
export class WorkerImageSetupApplication {
  constructor(private readonly ports: WorkerImagePorts, private readonly now: () => string = () => new Date().toISOString()) {}
  async prepare(request: Readonly<{ imageId?: string }> = {}): Promise<WorkerImageStatus> {
    if (!request.imageId && await this.ports.receipt()) return 'present';
    const sources = await this.ports.sources();
    if (request.imageId) {
      const recipe = recipeOf(sources.recipe), card = { mode: 'adopt', imageVersion: recipe.imageVersion, imageId: request.imageId } as const;
      if (!await this.ports.confirm(card)) return 'declined';
      await this.ports.build({ imageVersion: recipe.imageVersion, recipe, dockerfile: sources.dockerfile, imageId: request.imageId });
      return 'adopted';
    }
    const held = await this.ports.held(), plan = planFirstWorkerImage({ ...sources, held, plannedAt: this.now() });
    if (!await this.ports.confirm({ mode: 'build', imageVersion: plan.imageVersion, held })) return 'declined';
    await this.ports.build(plan);
    return 'built';
  }
}
