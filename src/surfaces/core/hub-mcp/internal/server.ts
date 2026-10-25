import { Server, ProtocolError, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HUB_LIMITS, canonicalHubJson, type HubSkillItem } from '#domain/index.js';
import { HubServerError, type HubServerApplication, type HubServerContext, type HubSkillRef, type HubStoredVersion } from '#engine/index.js';
import { sha256, PACKAGE_NAME, PACKAGE_VERSION, DeckentJsonSchemaValidator } from '#platform/index.js';

const extension = 'io.modelcontextprotocol/skills'; // Standard extension id, not a mutable Deckent domain.
const cache = { resultType: 'complete' as const, ttlMs: 0, cacheScope: 'private' as const };
const meta = z.object({ _meta: z.record(z.unknown()).optional() });
const listParams = meta.extend({ cursor: z.string().max(HUB_LIMITS.packageMaxBytes).optional() }).strict();
const getParams = meta.extend({ uri: z.string().max(HUB_LIMITS.packageMaxBytes) }).strict();
const encoded = (value: string) => encodeURIComponent(value);
const resourcePath = (path: string) => path.split('/').map(encoded).join('/');
function skillRoot(row: HubStoredVersion, skill: HubSkillItem) {
  // Last parent segment must match frontmatter.name; version precedes it (stable ext-skills requirement).
  return `skill://${row.manifest.packageId.split('/').map(encoded).join('/')}/${encoded(row.manifest.version)}/${skill.name}/`;
}
function address(uri: string) {
  // Resolve by a canonical URI, never by a decoded filesystem path or an arbitrary resource scheme.
  const match = /^skill:\/\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
  try { return { packageId: `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`, version: decodeURIComponent(match[3]!), name: match[4]!, path: match[5]!.split('/').map(decodeURIComponent).join('/') }; }
  catch { throw new HubServerError('HUB_RESOURCE_UNKNOWN'); }
}
function skillEntry(row: HubStoredVersion, skill: HubSkillItem) {
  const root = skillRoot(row, skill);
  const extra = [
    { path: 'deckent-package.json', text: canonicalHubJson(row.manifest) },
    { path: 'deckent-envelope.json', text: canonicalHubJson(row.envelope) },
  ];
  return { uri: `${root}SKILL.md`, frontmatter: { name: skill.name, description: skill.description },
    resources: [...skill.files.map(file => ({ uri: `${root}${resourcePath(file.path)}`, digest: `sha256:${file.digest}`, size: file.size })),
      ...extra.map(file => ({ uri: `${root}${resourcePath(file.path)}`, digest: `sha256:${sha256(file.text)}`, size: Buffer.byteLength(file.text) }))] };
}
/** Transport-free factory. H4 must host it through the SDK createMcpHandler/serveStdio entry for the modern era.
 * H4 supplies authenticated per-request context and owns network/auth/lifecycle policy. */
export function createHubSkillsServer(app: HubServerApplication, context: (request: ServerContext) => HubServerContext) {
  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, {
    supportedProtocolVersions: ['2026-07-28'],
    capabilities: { resources: {}, extensions: { [extension]: {} } }, jsonSchemaValidator: new DeckentJsonSchemaValidator(),
  });
  const fail = (error: unknown): never => {
    if (error instanceof HubServerError && error.code === 'HUB_RESOURCE_UNKNOWN') throw new ProtocolError(-32602, error.message);
    throw error;
  };
  const refEntry = async (ctx: HubServerContext, ref: HubSkillRef) => {
    const row = await app.inspect(ctx, ref.packageId, ref.version);
    const skill = row.manifest.items.find((item): item is HubSkillItem => item.kind === 'skill' && item.skillId === ref.skillId);
    if (!skill) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
    return skillEntry(row, skill);
  };
  const lookup = async (ctx: HubServerContext, uri: string) => {
    const parsed = address(uri), row = await app.inspect(ctx, parsed.packageId, parsed.version);
    const skill = row.manifest.items.find((item): item is HubSkillItem => item.kind === 'skill' && item.name === parsed.name);
    if (!skill || `${skillRoot(row, skill)}${resourcePath(parsed.path)}` !== uri) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
    return { row, skill, path: parsed.path };
  };
  server.setRequestHandler('skills/list', { params: listParams }, async (params, request) => {
    try {
      const ctx = context(request), refs = await app.listSkills(ctx, params.cursor ?? '', HUB_LIMITS.searchPageMax);
      const skills = await Promise.all(refs.map(ref => refEntry(ctx, ref)));
      const last = refs.at(-1), more = last && (await app.listSkills(ctx, last.key, 1)).length > 0;
      return { ...cache, skills, ...(more ? { nextCursor: last.key } : {}) };
    } catch (error) { return fail(error); }
  });
  server.setRequestHandler('skills/get', { params: getParams }, async (params, request) => {
    try {
      const { row, skill, path } = await lookup(context(request), params.uri);
      if (path !== 'SKILL.md') throw new HubServerError('HUB_RESOURCE_UNKNOWN');
      return { ...cache, skill: skillEntry(row, skill) };
    } catch (error) { return fail(error); }
  });
  server.setRequestHandler('resources/list', async () => ({ ...cache, resources: [] }));
  server.setRequestHandler('resources/read', async (request, extra) => {
    try {
      const ctx = context(extra), { row, skill, path } = await lookup(ctx, request.params.uri);
      const generated = path === 'deckent-package.json' ? canonicalHubJson(row.manifest) : path === 'deckent-envelope.json' ? canonicalHubJson(row.envelope) : null;
      if (generated !== null) return { ...cache, contents: [{ uri: request.params.uri, mimeType: 'application/json', text: generated }] };
      const file = skill.files.find(file => file.path === path);
      if (!file) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
      const bytes = await app.readFile(ctx, row.manifest.packageId, row.manifest.version, `skills/${skill.name}/${path}`);
      return { ...cache, contents: [{ uri: request.params.uri, mimeType: file.mediaType, blob: Buffer.from(bytes).toString('base64') }] };
    } catch (error) { return fail(error); }
  });
  return server;
}
