/** The product layout path family for a host: the same mapping production composition passes to `resolveProductLayout` (config layers,
 * bootstrap observer, global scope). Fixtures pass it so a native Windows root (`C:\…`) is absolute; it is `posix` on Linux and macOS. */
export function hostLayoutPlatform(platform: string = process.platform): 'posix' | 'win32' { return platform === 'win32' ? 'win32' : 'posix'; }
/** A fixture user home every platform resolves: the product reads HOME on POSIX and USERPROFILE on native Windows (global scope). */
export function homeEnv(home: string): { readonly HOME: string; readonly USERPROFILE: string } { return { HOME: home, USERPROFILE: home }; }
