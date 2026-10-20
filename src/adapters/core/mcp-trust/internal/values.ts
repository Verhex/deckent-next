import { hasSecret, terminalSafeText, type KnownSecretSnapshot } from '#platform/index.js';
import REGISTRY from './registry.json' with { type: 'json' };

/** SEC-2 (F30): the variables a project registry file may read (`registry.json`), never a credential name list to grow. */
export const MCP_PROJECT_VARIABLES: ReadonlySet<string> = new Set(REGISTRY.projectVariables);
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/iu;
/** An allowlisted variable's value that still carries a credential (URL user info, a credential pattern, a known installation secret) is refused. */
export const mcpProjectValueRefused = (value: string, known?: KnownSecretSnapshot) => USERINFO.test(value) || hasSecret(value, known);
// Matching control characters is the point (F28): they are launch values, never display text.
// eslint-disable-next-line no-control-regex
const LAUNCH_REFUSED = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/u;
const BIDI = /[‎‏‪-‮⁦-⁩]/gu;
/** SEC-2 (F28): a command, argument or URL carries no control character (CR, LF, ESC, …) and no bidirectional override. */
export const mcpLaunchTextValid = (text: string) => !LAUNCH_REFUSED.test(text);
/** One field of a trust card on one line: escapes removed (`terminalSafeText`), line breaks and tabs shown as `\n`/`\t`, no bidi override. */
export const mcpCardLine = (text: string) => terminalSafeText(text).replace(/\n/gu, '\\n').replace(/\t/gu, '\\t').replace(BIDI, '');
