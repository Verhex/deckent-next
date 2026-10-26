// FIX8a R27: the CLI entry's first import in every distribution: production React here, the caller's own NODE_ENV for every process it starts.
import { adoptProductionReact } from '#platform/index.js';
adoptProductionReact();
