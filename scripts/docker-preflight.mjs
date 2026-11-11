import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { release } from 'node:os';

export const DOCKER_PREFLIGHT_INPUTS = ['scripts/docker-preflight.mjs', 'packaging/bwrap/locales/en.json', 'packaging/bwrap/locales/tr.json'];
const catalogs = Object.fromEntries(['en', 'tr'].map(locale => [locale,
  JSON.parse(readFileSync(new URL(`../packaging/bwrap/locales/${locale}.json`, import.meta.url), 'utf8'))]));

// Build tools run before dist exists; both entry points share this bootstrap catalog renderer.
export function dockerUnavailableMessage({ execute = execFileSync, env = process.env, kernel = release(), canonical = realpathSync } = {}) {
  const language = [env.DECKENT_LANGUAGE, env.DECKENT_LANG, env.LC_ALL, env.LANG]
    .map(value => value?.slice(0, 2).toLowerCase()).find(value => Object.hasOwn(catalogs, value)) ?? 'en';
  const text = key => catalogs[language][`docker.${key}`];
  let context, host = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
  if (!host) {
    try {
      [context] = JSON.parse(execute('docker', ['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : [])],
        { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }));
      host = context?.Endpoints?.docker?.Host;
    } catch { /* Unknown contexts get all three recovery paths. */ }
  }
  let socket = host?.startsWith('unix://') ? host.slice(7) : '';
  try { if (socket) socket = canonical(socket); } catch { /* A stopped daemon may have no socket. */ }
  const desktop = /docker-desktop|shared-docker|desktop\/docker\.sock/u.test(socket)
    || context?.Name === 'desktop-linux' || /docker desktop/iu.test(context?.Metadata?.Description ?? '');
  const rootless = /^\/run\/user\/\d+\/docker\.sock$/u.test(socket)
    || (env.XDG_RUNTIME_DIR && socket === `${env.XDG_RUNTIME_DIR}/docker.sock`) || (socket && context?.Name === 'rootless');
  // WSL alone is not Desktop evidence: it can also host a rootless or system daemon.
  const kind = desktop ? 'desktop' : rootless ? 'rootless'
    : /^\/(?:var\/)?run\/docker\.sock$/u.test(socket) && !/microsoft|wsl/iu.test(kernel) ? 'rootful' : 'unknown';
  const hints = kind === 'unknown' ? [text('unknown'), text('rootless'), text('rootful'), text('desktop')] : [text(kind)];
  return [text('unavailable'), ...hints, text('retry')].join('\n');
}

export function requireDocker(code, execute = execFileSync) {
  try {
    execute('docker', ['info', '--format', '{{json .ServerVersion}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  } catch {
    // Never print raw daemon/context errors: remote endpoints can contain credentials.
    throw new Error(`${code}: ${dockerUnavailableMessage({ execute })}`);
  }
}
