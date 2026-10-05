import { createContext, useContext } from 'react';
import { Box, Text } from 'ink';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { useWorklinePalette, type InkRoleStyle } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from './status-row.js';
import { projectHumanInline, projectHumanText } from './human-text.js';
import { SpanText } from './lines-view.js';

/** Operation-scoped opaque config provenance, never raw values or a second credential store. */
export const HumanTextContext = createContext<KnownSecretSnapshot | undefined>(undefined);
export const useHumanTextSecrets = () => useContext(HumanTextContext);

export function HiddenTextNotice({ count, label }: { readonly count: number; readonly label: string | undefined }) {
  const palette = useWorklinePalette();
  return count > 0 && label ? <Text {...palette.warning} wrap="wrap">{fillTemplate(label, { count })}</Text> : null;
}

export function HumanTextRow({ text, prefix = '', style, hiddenLabel, inline = false }: {
  readonly text: string; readonly prefix?: string; readonly style: InkRoleStyle; readonly hiddenLabel: string | undefined; readonly inline?: boolean;
}) {
  const known = useHumanTextSecrets();
  const projection = inline ? projectHumanInline(text, known) : projectHumanText(text, 'prose', known);
  return <Box flexDirection="column"><Text {...style}>{prefix}<SpanText spans={projection.spans} /></Text>
    <HiddenTextNotice count={projection.hiddenCount} label={hiddenLabel} /></Box>;
}
