import clien from '../locales/en/cli.json' with { type: 'json' };
import tuien from '../locales/en/tui.json' with { type: 'json' };
import runen from '../locales/en/run.json' with { type: 'json' };
import opsen from '../locales/en/ops.json' with { type: 'json' };
import surfaceen from '../locales/en/surface.json' with { type: 'json' };
import governanceen from '../locales/en/governance.json' with { type: 'json' };
import remoteen from '../locales/en/remote.json' with { type: 'json' };
import nativeen from '../locales/en/native.json' with { type: 'json' };
import desktopen from '../locales/en/desktop.json' with { type: 'json' };
import miscen from '../locales/en/misc.json' with { type: 'json' };
import clitr from '../locales/tr/cli.json' with { type: 'json' };
import tuitr from '../locales/tr/tui.json' with { type: 'json' };
import runtr from '../locales/tr/run.json' with { type: 'json' };
import opstr from '../locales/tr/ops.json' with { type: 'json' };
import surfacetr from '../locales/tr/surface.json' with { type: 'json' };
import governancetr from '../locales/tr/governance.json' with { type: 'json' };
import remotetr from '../locales/tr/remote.json' with { type: 'json' };
import nativetr from '../locales/tr/native.json' with { type: 'json' };
import desktoptr from '../locales/tr/desktop.json' with { type: 'json' };
import misctr from '../locales/tr/misc.json' with { type: 'json' };

export type MessageKey = keyof typeof clien | keyof typeof tuien | keyof typeof runen | keyof typeof opsen | keyof typeof surfaceen | keyof typeof governanceen | keyof typeof remoteen | keyof typeof nativeen | keyof typeof desktopen | keyof typeof miscen;
export const families = [
  { en: clien, tr: clitr },
  { en: tuien, tr: tuitr },
  { en: runen, tr: runtr },
  { en: opsen, tr: opstr },
  { en: surfaceen, tr: surfacetr },
  { en: governanceen, tr: governancetr },
  { en: remoteen, tr: remotetr },
  { en: nativeen, tr: nativetr },
  { en: desktopen, tr: desktoptr },
  { en: miscen, tr: misctr },
] as const;
