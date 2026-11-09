import CREDENTIAL_PATHS from './credential-paths.json' with { type: 'json' };

/** Shared read credential floor; patches add this to their existing exclusions (owner DENY 2a). */
export const WORKSPACE_CREDENTIAL_DENY: readonly string[] = Object.freeze(['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key',
  '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.credentials.json', '**/.npmrc', '**/.netrc',
  '.deckent/host/**', '.deckent/audit-key/**', '.deckent/approvals/**',
  // Credential carriers the legacy shell classifier protected (T-L4 slice 3a): one protected set for read tools, shell and edits.
  ...CREDENTIAL_PATHS,
  '**/*.pfx', '**/*.keystore', '**/*.jks', '**/.pypirc', '**/credentials', '**/credentials.json', '**/secrets.json', '**/secrets.sealed.json', '.brain/memory.db*',
]);

/** Exact HOME locations, never wildcard patterns. */
export const HOME_CREDENTIAL_PATHS: readonly string[] = Object.freeze(CREDENTIAL_PATHS.map(pattern => pattern.replace(/^\*\*\//u, ''))
  .filter(path => !path.includes('*') && !path.includes('?')));
