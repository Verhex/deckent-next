import { createContext, useContext } from 'react';
import { Box, Text } from 'ink';
import type { KnownSecretSnapshot } from '#platform/index.js';
import { type InkRoleStyle, useWorklinePalette } from '#surfaces/core/terminal-kit-ink/index.js';
import { fillTemplate } from '#surfaces/core/terminal-render/index.js';
import { modelIngressHiddenCount, projectHumanInline, projectHumanText } from '#surfaces/core/terminal-render/index.js';
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
    <HiddenTextNotice count={projection.hiddenCount + modelIngressHiddenCount(text)} label={hiddenLabel} /></Box>;
}
