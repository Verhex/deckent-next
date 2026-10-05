import { createElement } from 'react';
import { render, Text, useInput } from 'ink';

function Frame({ state }) {
  useInput(() => {});
  return createElement(Text, null, `Permission mode: full-auto\n${state}`);
}
const frame = state => createElement(Frame, { state });
const instance = render(frame('Ready'), { interactive: true, patchConsole: false });
await instance.waitUntilRenderFlush();
instance.clear();
instance.rerender(frame('Ready again'));
await instance.waitUntilRenderFlush();
instance.unmount();
