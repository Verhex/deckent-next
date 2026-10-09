/** OpenRouter OpenAPI verified 2026-10-09: these plugins expose enabled:false. Server tools are
 * unreachable because the shared request schema accepts only type:function tools; :online model
 * suffixes are refused. Account-enforced plugins remain a separate admission precondition.
 */
export const openRouterRequestControls = Object.freeze({ modalities: Object.freeze(['text'] as const),
  plugins: Object.freeze(['web', 'file-parser', 'response-healing', 'context-compression', 'auto-router', 'auto-beta-router', 'pareto-router', 'fusion']
    .map(id => Object.freeze({ id, enabled: false as const }))) });
