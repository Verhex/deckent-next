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
import helpen from '../locales/en/help.json' with { type: 'json' };
import clirunen from '../locales/en/clirun.json' with { type: 'json' };
import clitasken from '../locales/en/clitask.json' with { type: 'json' };
import cliapprovalen from '../locales/en/cliapproval.json' with { type: 'json' };
import clisetupen from '../locales/en/clisetup.json' with { type: 'json' };
import cliadminen from '../locales/en/cliadmin.json' with { type: 'json' };
import climodelsen from '../locales/en/climodels.json' with { type: 'json' };
import clidoctoren from '../locales/en/clidoctor.json' with { type: 'json' };
import monitoren from '../locales/en/monitor.json' with { type: 'json' };
import setupen from '../locales/en/setup.json' with { type: 'json' };
import securityen from '../locales/en/security.json' with { type: 'json' };
import terminalen from '../locales/en/terminal.json' with { type: 'json' };
import deliveryen from '../locales/en/delivery.json' with { type: 'json' };
import termrunen from '../locales/en/termrun.json' with { type: 'json' };
import helptr from '../locales/tr/help.json' with { type: 'json' };
import cliruntr from '../locales/tr/clirun.json' with { type: 'json' };
import clitasktr from '../locales/tr/clitask.json' with { type: 'json' };
import cliapprovaltr from '../locales/tr/cliapproval.json' with { type: 'json' };
import clisetuptr from '../locales/tr/clisetup.json' with { type: 'json' };
import cliadmintr from '../locales/tr/cliadmin.json' with { type: 'json' };
import climodelstr from '../locales/tr/climodels.json' with { type: 'json' };
import clidoctortr from '../locales/tr/clidoctor.json' with { type: 'json' };
import monitortr from '../locales/tr/monitor.json' with { type: 'json' };
import setuptr from '../locales/tr/setup.json' with { type: 'json' };
import securitytr from '../locales/tr/security.json' with { type: 'json' };
import terminaltr from '../locales/tr/terminal.json' with { type: 'json' };
import deliverytr from '../locales/tr/delivery.json' with { type: 'json' };
import termruntr from '../locales/tr/termrun.json' with { type: 'json' };
import tuicopyen from '../locales/en/tuicopy.json' with { type: 'json' };
import tuinotifyen from '../locales/en/tuinotify.json' with { type: 'json' };
import tuiqueueen from '../locales/en/tuiqueue.json' with { type: 'json' };
import tuieditoren from '../locales/en/tuieditor.json' with { type: 'json' };
import tuisessionen from '../locales/en/tuisession.json' with { type: 'json' };
import tuicopytr from '../locales/tr/tuicopy.json' with { type: 'json' };
import tuinotifytr from '../locales/tr/tuinotify.json' with { type: 'json' };
import tuiqueuetr from '../locales/tr/tuiqueue.json' with { type: 'json' };
import tuieditortr from '../locales/tr/tuieditor.json' with { type: 'json' };
import tuisessiontr from '../locales/tr/tuisession.json' with { type: 'json' };

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
  { en: helpen, tr: helptr },
  { en: clirunen, tr: cliruntr },
  { en: clitasken, tr: clitasktr },
  { en: cliapprovalen, tr: cliapprovaltr },
  { en: clisetupen, tr: clisetuptr },
  { en: cliadminen, tr: cliadmintr },
  { en: climodelsen, tr: climodelstr },
  { en: clidoctoren, tr: clidoctortr },
  { en: monitoren, tr: monitortr },
  { en: setupen, tr: setuptr },
  { en: securityen, tr: securitytr },
  { en: terminalen, tr: terminaltr },
  { en: termrunen, tr: termruntr },
  { en: deliveryen, tr: deliverytr },
  { en: tuicopyen, tr: tuicopytr },
  { en: tuinotifyen, tr: tuinotifytr },
  { en: tuiqueueen, tr: tuiqueuetr },
  { en: tuieditoren, tr: tuieditortr },
  { en: tuisessionen, tr: tuisessiontr },
] as const;

// Derived from `families` (distributive over the tuple), not from the JSON imports: the emitted declaration then names no JSON module, which a
// consumer's type checker would refuse without resolveJsonModule (TS2732) or, under NodeNext, without an import attribute tsc does not emit (TS1543).
type FamilyKeys<F> = F extends { readonly en: infer E } ? keyof E : never;
export type MessageKey = FamilyKeys<(typeof families)[number]>;
