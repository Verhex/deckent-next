# Shell realms (bubblewrap, Landlock, doctor) — module note

Shell realm, bubblewrap and Landlock providers, doctor report, sandbox scan speed (moved from ARCHITECTURE.md Packages 2026-10-05).
Kaynak/Source: ARCHITECTURE.md @58537c7f lines 1278–1326, 1407–1498, 1663–1669; historical module text below is reconciled for W3 (2026-10-09).

**W3 security contract (owner 2026-10-09).** An approved shell may open the ordinary approval floor, but never product authority/configuration. Both sandbox providers enforce the hard floor independently of `writeFloorReadOnly`. Landlock's seccomp additionally denies chmod/chown syscall families globally (including mutating xattrs/ACLs), since Landlock filesystem rules do not mediate those metadata changes. This costs permission/ownership changes on ordinary project files in Landlock; bubblewrap keeps them outside protected read-only mounts.
Full-access calls require an open sandbox; `openShellRealm` returns `SHELL_SANDBOX_UNAVAILABLE` for Landlock, a host fallback or explicit host mode before execution. Closed modes retain their documented fallback (which has no filesystem isolation).
The shared data registry `workspace-read/internal/credential-paths.json` masks gh, Docker, kube, Codex, `.git-credentials`, AWS, Azure, gcloud, OCI, doctl, Aliyun, hcloud, IBM Cloud and Terraform credential carriers. Matched symlink credentials refuse the open view. HOME still has depth/entry bounds; custom credential locations and unmasked hard-link aliases remain outside this guarantee.
Open bubblewrap hides `/run` (including `/var/run` aliases and user session buses), the selected XDG runtime directory, configured Docker/D-Bus pathname sockets (an abstract session bus refuses the open view) and existing `/tmp/dbus-*` sockets; HOME and project walks mask socket entries. Closed bubblewrap hides runtime directories and masks project sockets; Landlock denies AF_UNIX creation through seccomp. No owner IPC grant is added. Custom IPC outside these paths and same-user races remain limits; Docker daemon escape itself is not exercised.
Full-auto classifies `find -delete`, `mv` and truncating file redirects as destructive; `>>`, descriptor duplication and `/dev/null` retain their separate classifications.
Official references verified 2026-10-09: [Landlock](https://docs.kernel.org/userspace-api/landlock.html), [bubblewrap options](https://github.com/containers/bubblewrap/blob/main/bwrap.xml); Context7 `/containers/bubblewrap` confirms mounts apply in argument order. Host tests and limits: external `proof/W3-SANDBOX-2026-10-09/WORKER.md`.

**Shell realm (S5, S9, S11; owner 2026-09-28).** Shell calls run through one `ShellRealm` port (host / bubblewrap / landlock).
`terminal.shell.realm = require-sandbox | prefer-sandbox | host` (default `prefer-sandbox`). The service probes once per process
(`ShellCapabilities` v2, BWRAP-SELECT): the bubblewrap launcher is selected and run once (below), the user namespace via a short-lived
native helper, the Landlock ABI; 2.5 s bound, failures `unknown`, nothing installed. The bubblewrap observation is `{ status, launcher,
rejected, restriction, detail }` — `available` only when the selected launcher's own sandbox run succeeded, `restricted` (typed, with the
fix) when that run met a user-namespace restriction; every rejected candidate is named. PATH is never read for the launcher. Sandbox
mechanisms are realm providers (`ShellSandbox.usable(capabilities)` → realm, result marker, a posture function of the call's write view, a notice when the posture
falls short — or why not), taken in preference order from a code-only composition port (`RuntimeServicePorts.shellSandboxes`; shipped
list **bubblewrap, then Landlock**). `host` → host (result bytes unchanged); a sandbox mode → the first usable provider; none usable →
`require-sandbox` refuses before any plan, approval or effect (`SHELL_SANDBOX_UNAVAILABLE`), `prefer-sandbox` runs on the host and says
so in the approval preview, the live stream, the model result and the finished line (`sandbox: none; running on host (bubblewrap: …;
landlock: …)`) — never a silent fallback. A later provider that wins after a preferred one was passed over **for any reason**
(REALM-NOTICE, live 2026-09-29: a host restriction such as AppArmor with its fix, a launcher inside the project or scratch area, an
unavailable or changed launcher) is a visible fallback too, in every sandbox mode: `[deckent] sandbox: <chosen> instead of <preferred>
(<preferred>: <reason>)` (one helper, `describeSandboxFallback`; each reason one line, control characters as spaces, at most 480
characters, `boundSandboxReason`) leads the resolution notice (live stream, model result) and follows the winning provider's posture
(approval card). The resolution carries the providers passed over (`rejected`, in order), which doctor reads. Lead decision 2026-09-29:
the notice stays on every fallback, including a host that always falls back (owner principle "never a silent fallback"; the cost is one
repeated line per shell call on such a host); macOS/Windows `SHELL_REALM_UNSUPPORTED`. Every result's first line names its realm (`sandbox:
bubblewrap | landlock | degraded | none`; only trusted metadata, never command output); the approval card renders that posture against the same `shellWritePosture` result the effect enforces (always `owner-approved` once a card exists; `sandboxWriteView` in `host-shell`), so its project, write-floor and `.git` wording cannot drift from the boundary (host and the no-sandbox fallback keep a fixed text).
Both sandbox launchers go through the host shell's one process runner (`ShellLaunch`: program, argv ending in `bash --noprofile --norc
-c`, optional fd 3 setup-failure channel), so the process-group, cancellation, timeout, output-bound and cleanup contract is the same
everywhere; a realm that cannot set itself up refuses the call (`spawn-failed` → effect `refused`, the reason is the result: "nothing
was run"), never runs on the host instead.
**Bubblewrap realm (S9).** `adapters/core/shell-sandbox-bwrap`: `bwrap … -- bash` with the launcher the probe selected
(BWRAP-SELECT, owner S1–S3/S6 2026-09-29, eleventh batch): first a system file at `/usr/bin/bwrap`, `/usr/local/bin/bwrap` or `/bin/bwrap`
(merged `/usr` tried once by canonical path) that is a regular executable, not a symbolic link, root-owned, not writable by group/others,
without setuid/setgid, in root-owned directories not writable by group/others up to `/`, whose `--version` is at least **0.12.0**
(GHSA-pxhw-h44j-8pfx / CVE-2026-87766; a distribution backport is not recognized); otherwise the **bundled build**
(`dist/adapters/core/shell-sandbox-bwrap/bundled/linux-<arch>/bwrap`, resolved from the module URL): its bytes are read once, must hash to
`BUBBLEWRAP_BUNDLED` (generated from `packaging/bwrap/bwrap.lock.json`), and the same bytes are written to `<global state
root>/bin/bwrap-<sha256>` (0700 directory, 0500 file, unique temporary + fsync, published with `link` — never replacing — so concurrent
processes normally run one inode (not when a publisher stalls > 0.5 s: its copy may then be replaced by another verifying copy); the check waits ≤ 0.5 s while a publisher's temporary name is still linked; only a copy that does not verify
is replaced by `rename`; an existing copy is reused only when ours, single-link and verifying; a replacing `rename` refused 29/120
concurrent measurements with nlink 0, 2026-09-30) — that copy is what runs, so an npm install under umask 002 (package file 0775) is not a problem and the package tree's
permissions are not trusted. PATH never consulted. The probe runs the selected launcher once (`--unshare-all --die-with-parent --new-session
--ro-bind / / --proc /proc --dev /dev -- /bin/true`, env empty, 1 s); the realm is usable only when that run succeeded, and on every use the
launcher file must still be the measured one (`dev:ino:size:mtimeNs:ctimeNs`; the bundled copy is re-hashed when its identity moved, a
changed system file needs a service restart). A launcher inside the project or the scratch area (a state root pointed there) is refused: a
sandboxed command could replace it. `launcher.overlay` (≥ 0.11.0) is what SHELL-OVERLAY reads. Bundled 0.13.0 is built with
`-Dassume_kernel=5.15.0` (owner S6: minimum kernel 5.15). Development and tests: `npm run build` stages the locked build into the gitignored
`src/…/bundled/` from a verifying build-bwrap output (`DECKENT_BWRAP_BUILD` or `.pack/bwrap/*`) and says loudly when none exists;
`bwrap-real-sandbox-guard.test.ts` fails a Linux host with open user namespaces that selected no working launcher with overlay (the
bubblewrap tests would otherwise skip); vitest gives every worker a temporary `DECKENT_GLOBAL_HOME`, so the realized copy never lands in
the owner's `~/.deckent/bin` (the development entry `.agents/refactor/next-entry.mjs` keeps its global home outside the checkout,
`~/.local/state/deckent-next-dev`, 0360bab9: a home inside the project put the copy there, which the rule above refuses — live 2026-09-29).
`selectBubblewrapLauncher({ place: false })` is the read-only measurement (doctor): an already placed, verifying copy is used; nothing is
created, written or re-moded, and a copy the service has not placed yet is reported as "not placed … yet". The shipped provider list is
one function, `shippedShellSandboxes(layout)` (bubblewrap, then Landlock): the service's default port, MCP `inspect` starts and doctor.

**Doctor realm report (REALM-NOTICE).** `doctor` (`--json` field `shellRealm`, schemaVersion 1, additive to doctor schemaVersion 2,
`null` when unwired; human lines in the product's own sandbox words, no catalog text — the result marker with `[terminal.shell.realm
<mode>]`, then the notice or the reasons) reports the realm a shell call in this project gets under the configured mode, every provider
passed over and why, and the host measurement (`bubblewrap: {status, launcher {source, path, version, overlay}, rejected, detail}`,
`landlock`), measured read-only with the state root the service uses (`globalStateRoot()`), so "probe available, provider refuses" is
visible. Host mode also reports `preferSandbox` (the MCP registry default). Measured in the CLI process: a running service keeps its own
measurement until it restarts; no conversation scratch area (a launcher inside only the scratch area is not detected by doctor). (Closed view — standart, full-auto and unattended calls; a full-access call's open view is under Full access (MODES-3).) View per call: `--unshare-all` (network included; the
fetch tool is the only egress), `--die-with-parent`, `--new-session`, fresh `/proc`, minimal `/dev`, `/tmp` and HOME as 64 MiB tmpfs
(HOME never bound: `~/.ssh`, tokens, a ledger under HOME invisible), system prefixes read-only by allowlist (`/usr /etc /bin /sbin
/lib* /opt /snap /nix /sys`; never `/`, `/mnt`, `/run`, `/var`, `/home`), PATH program directories (`bin`/`.bin`/`sbin` by name; a
`bin` with its `lib*`/`libexec` siblings; never HOME or above it, never inside/above the project or scratch, never under `/mnt /media
/run /dev /proc /sys /var`, never a non-program directory such as `~/.local`) read-only so an nvm/`~/.local/bin` toolchain keeps
working — every bind source, the entry and each `lib*`/`libexec` sibling, must be its own canonical directory (no link in any
component) admitted by the same exclusions, so `lib -> $HOME` beside a `bin` is never a bind and a symbolic-link toolchain directory is
not bound at all (Astra 2154 R1; a component swapped for a link between the check and the mount is the documented same-user race) —,
the project read-write, Git metadata under the **inode floor before any grant (Astra 2156)**: a `.git` file that has more than one link
is another name of something and is masked (never a grant, never a worktree resolution); a `.git` directory anywhere, the root `.git`
file (a worktree) and — only in the verified worktree shape (`gitWorktreeRepository`, shared with Landlock) — its common repository are
bound read-only and then walked: every multi-linked file inside is masked unless its content hashes to its Git object or pack name
(`isVerifiedGitObject`: loose objects inflated and hashed, packs/indexes by their trailer checksum; a hard-linked local clone keeps its
objects), an unreadable or too deep directory inside is masked; any other `.git` file opens nothing (a forged pointer a sandboxed
command wrote cannot bind HOME; a submodule loses `git status` inside). The per-directory scan is shared with Landlock
(`scanGitDirectory`) and its security verdict is taken **afresh on every call** — the directory is listed and every regular file's link
count is read each time; no directory-level cache carries a child's verdict (Astra 2158 R1: a single-link file can gain another name
elsewhere and be rewritten through it without its directory's times changing). Only a verified object's content hash is cached, under
the inode's device, number, size, mtime, **ctime** and the identity its path promises (Astra 2158 R2: content cannot change without the
kernel advancing ctime — a user can put mtime back with `utime`, never ctime; the same inode under another object name is re-verified).
Bounds of that cache, stated honestly: ctime is kernel-set at nanosecond resolution, so a change landing in the same tick as the cached
ctime, or a component swapped between the scan and the mount, is outside what the scan can see. Git metadata has its own walk budget
(200 000 entries; over it, or over 4 096 masks — e.g. a hard-linked clone whose objects do not verify — the call is refused), the deny
floor masked (denied directories and fully-denied subtrees as empty tmpfs; denied files as a read-only `/dev/null` bind that opens with
EACCES — protected, not absent; a regular file with more than one link is masked the same way, since another name of a protected inode
would open it (Astra 2154 R2; single-link files stay open; inside Git metadata the same rule applies with the verified-object exemption
above — the multi-link protection covers the whole project view including `.git`, not only the working tree); symlinks neither followed
nor masked; `node_modules`/`dist`-class directories not entered), the conversation's scratch area read-write (TMPDIR unchanged). What
the walk could not see is closed, never left read-write (Astra 2154 R3): a directory it could not read, or one beyond depth 32, is
masked as an empty tmpfs (a `chmod` inside changes the tmpfs, not the host directory); an unreadable project root refuses the call.
Deny walk bounded (50 000 entries / 4 096 masks; over it the call is refused). The PID namespace ends every process the command started
with the call, a `setsid` escapee included (measured: without `--die-with-parent` it survives); the outer `bwrap` exits on SIGTERM, so
cancellation and the timeout end the namespace. Result marker `sandbox: bubblewrap`; card "Runs in a bubblewrap sandbox: …". Cost on
this machine ≈ 420 ms per call (Astra 2158: the common repository's 6.2 k-entry `.git` is listed and its ≈ 5.1 k files `lstat`ed on
every call — the thread-pool round trips dominate, ≈ 220 ms; the first call after service start ≈ 700 ms while 797 hard-linked objects
are hashed once; ≈ 180 ms with the withdrawn directory cache, ≈ 145 ms before 2156, ≈ 90 ms before 2154) vs ≈ 2 ms on the host. Open
limits: masked files read "Permission denied" rather than ENOENT; ignored-tree exception (both realms): `node_modules`/`dist`-class
directories are not scanned, so a `node_modules/pkg/.env` is readable and a nested `node_modules/pkg/.git/config` writable inside
(Astra 2154 measured both; owner option: mask/carve every `.git` and deny match inside ignored trees at the cost of scanning them);
`.git` read-only means `git commit`/`git add` fail inside (owner decision); the product's own state inside the project (ledger, policy,
sessions, audit, keys — every resource but the configuration, TERM-FEEDBACK-1) is closed in the sandbox in every layout, an ignored
ancestor included (Astra 2162: the deny list's nested literal heads are `WorkspaceScope.protectedAnchors`; an ignored directory holding
one is listed, its denied entries masked and only the ancestors entered — siblings stay unscanned; a symbolic link on that chain
refuses the call; a `.gitignore` change cannot lift this); AppArmor-restricted Ubuntu (24.04 with the restriction on, 25.04+) is typed
`restricted` from the launcher's own run and falls back to Landlock visibly; this machine (WSL2) has no restriction sysctl, so that path is
unit-tested, not measured here; a selected launcher whose run fails is not replaced by the next candidate; between the per-use identity
check and `spawn` the copy can be swapped by the same user (0700 directory: no other principal; fd-exec not used); aarch64 is built but not
shipped until a real arm64 realm test (lock `shipArches`); `/bin/true` is the probe's command (a distribution without it reads
`unavailable`, with the reason); `--die-with-parent` should also end a sandboxed command when the service dies
(candidate for the "Host shell execution" orphan item) — untested.
**Landlock realm (S11).** Second provider (chosen when bubblewrap is not usable): each call builds a rule set from a fresh scan of the
project (`host-shell/internal/landlock.ts`) and runs bash through the native helper `shell-sandbox`
(`host-shell/native/shell_sandbox.c`), which applies it and execs bash in the same process. Landlock only adds access and a directory
rule reaches everything beneath it, so a directory holding a protected path or a `.git` is carved: listing only, each entry its own
rule — clean files and trees read-write, protected paths (the turn's deny list), multiply linked files, special files and unreadable
directories no rule; symbolic links none; ignored directories read-write as a whole and not scanned. Git metadata is read-only under
the same inode floor **before any grant (Astra 2156)**: a multi-linked `.git` file takes no rule; a `.git` directory and a worktree's
common repository (root `.git` file in the verified shape only) are not one read grant but carved read rules from the shared
`scanGitDirectory` (verdicts re-read every call, only object hashes cached under ctime and expected identity — Astra 2158): a directory
whose subtree holds only single-link files, verified objects (`isVerifiedGitObject`) and readable directories takes one `r` rule,
otherwise listing only and per-entry rules — a multi-linked unverified file, a symbolic link, an unreadable or too deep directory none
(git metadata budget 200 000 entries; over it the set is refused). No other `.git` file opens anything outside. System directories
(`/usr /bin /sbin /lib* /opt`, the running Node's `bin`/`lib`) read + execute, `/etc` and `/proc` read,
`/dev/{null,zero,full,random,urandom}` read-write; the scratch area read-write and the command's `HOME`; HOME, `/tmp`, `/mnt`, `/run`,
`/var`, `/sys` and everything else unreachable (`stat` is not restricted by Landlock). Bounds: 20 000 scanned entries, depth 32, 8 192
rules, 1 MiB of rule arguments — past a bound nothing runs (beyond depth 32 the whole set is refused; a directory the scan cannot read
takes no rule and stays unreachable even after a `chmod` inside — pinned by tests after Astra 2154 R3). The helper opens relative rule
paths beneath the root with `openat2 RESOLVE_BENEATH|NO_SYMLINKS`, requires the announced kernel ABI, sets `PR_SET_NO_NEW_PRIVS`,
restricts itself (ABI ≥ 4: TCP bind/connect handled with no rule; ABI ≥ 6: signal and abstract-unix scopes), then installs a seccomp
filter (foreign-architecture/x32 calls kill; `io_uring_setup` refused; `socket()` refused except AF_INET/AF_INET6 stream sockets when
Landlock handles TCP — ABI < 4: every socket refused; `listen()` and MSG_FASTOPEN sends refused: measured on ABI 7 that a unix socket
reached `/var/run/docker.sock`, UDP left the machine, and the Landlock TCP rule missed a `listen()` autobind and a TCP Fast Open
connect). Any setup failure is one line on fd 3 (close-on-exec), exit 125, no exec; the runner turns it into `spawn-failed` (effect
refused), so a command cannot forge one. Posture: ABI ≥ 6 → marker `sandbox: landlock`; ABI < 6 → typed DEGRADED: marker `sandbox:
degraded` and a notice naming what is open (signals ABI < 6, TCP by the socket filter ABI < 4) on the card, the
live stream, the result and the finished line. Network is closed at every supported ABI; ABI <3 is refused to preserve truncation protection. A system read grant overlapping an absolute installation root also refuses the call; closed bubblewrap hides external installation roots over system binds. Open limits: the project root and every directory
holding a protected path or `.git` cannot gain, lose or rename entries inside the sandbox (`touch new-at-root`, `sed -i` of a root
file, a first `mkdir dist`); tools installed under HOME do not run (unlike bubblewrap); glob-protected files inside ignored directories
are not carved; no PID namespace — a `setsid` descendant escapes the process group (it stays in the Landlock domain); ≈ 310 ms rule-set
build on this repository after Astra 2158 (≈ 125 ms with the withdrawn directory cache, ≈ 90 ms before 2156; per-entry object rules for
a carved `objects/` tree can approach the 8 192-rule bound in a large hard-linked clone whose objects do not verify); the product's own
state inside the project is closed in every layout, an ignored ancestor included (Astra 2162: an ignored directory holding a protected
anchor is carved — listing only, denied entries no rule, the ancestors carved in turn, every other entry keeps its read-write grant
unscanned, except a write-floor entry of a floor-read-only call, which takes a read-only rule (869c01f); a symbolic link on the chain
refuses the set).

**Sandbox scan speed (SANDBOX-SPEED G2, seventh batch).** Both realms' scans pick their reads per directory by `statfs`: synchronous on
a local file system, asynchronous elsewhere (`fs-ops`); the verdict is re-read on every call and does not depend on the read flavour
(Astra 2158 holds). The deny matcher answers the shapes the deny list is made of — `**/<segment glob>`, a literal, a literal head with one
trailing `*` or `**` — without the dynamic program, on the platform's one wildcard set (`GLOB_WILDCARD`, only `*` and `?`); equivalence
with the general matcher is an oracle test. Measured on this repository (ext4/WSL2, warm): bubblewrap ~465 → ~60 ms, Landlock ~316 →
~51 ms per call. Open: execution off the event loop (~50 ms block), network file systems, `statfs`/`readdir` micro-costs.


**Bubblewrap ad sızıntısı (SANDBOX-AD-SIZINTISI, 2026-10-06).** Yalnız ürün durumu tutan dizin boş salt-okunur tmpfs olur (`BubblewrapView.emptiedDirectories`, `--perms 0555 --tmpfs` + `--remount-ro`): içerik ve giriş adları görünmez; karma dizin (ürün durumu + proje dosyası yan yana) giriş-başı maskede kalır; scratch bağı içte yazılabilir kalır; layout kökü hiç emptied olmaz. Açık sınır: karma dizinlerde ürün dosyası adları listelenir (lead kabul); scratch yolu (`.deckent/.../state/scratch/…`) çağrının kendi TMPDIR'i olarak görünür kalır (taşınmadan gizlenemez).
