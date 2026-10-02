import configen from '../locales/en/config.json' with { type: 'json' };
import configtr from '../locales/tr/config.json' with { type: 'json' };
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

export const families = [
  { en: configen, tr: configtr },
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

// Derived from `families` (distributive over the tuple), not from the JSON imports: the emitted declaration then names no JSON module, which a
// consumer's type checker would refuse without resolveJsonModule (TS2732) or, under NodeNext, without an import attribute tsc does not emit (TS1543).
type FamilyKeys<F> = F extends { readonly en: infer E } ? keyof E : never;
export type MessageKey = FamilyKeys<(typeof families)[number]>;
