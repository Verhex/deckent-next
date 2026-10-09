// S11: runs one command inside a Landlock domain with a seccomp socket filter, then execs it in the same process.
//
//   shell-sandbox --abi N --root <abs> {--rule <x|r|w|l|d> <path>}* -- <program> <arg>...
//
// The caller (host-shell/internal/landlock.ts) builds the rule set; this helper only enforces it and fails closed: any error is
// one line on fd 3 (the status channel, close-on-exec), exit 125, and nothing is executed. A successful exec closes fd 3 with
// nothing written, so a command can never forge a setup failure through its own output or exit code.
// Relative rule paths are opened beneath --root with no symbolic link in any component (openat2 RESOLVE_BENEATH|NO_SYMLINKS):
// a path swapped for a link between the caller's scan and this open cannot move a rule outside the project. Absolute paths
// (system directories, the scratch area) are opened as given.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <netinet/in.h>
#include <unistd.h>

// Stable Linux UAPI numbers on the two supported native architectures, even with older build headers.
// Linux v6.18 arch/x86/entry/syscalls/syscall_64.tbl and scripts/syscall.tbl.
#if defined(__x86_64__) || defined(__aarch64__)
#ifndef SYS_fchmodat2
#define SYS_fchmodat2 452
#endif
#ifndef SYS_setxattrat
#define SYS_setxattrat 463
#endif
#ifndef SYS_removexattrat
#define SYS_removexattrat 466
#endif
#endif

// Landlock UAPI values (defined here so an older system header still builds; the kernel ABI is queried at run time).
#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1
#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)
#define FS_TRUNCATE (1ULL << 14)
#define FS_IOCTL_DEV (1ULL << 15)
#define NET_BIND_TCP (1ULL << 0)
#define NET_CONNECT_TCP (1ULL << 1)
#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define SCOPE_SIGNAL (1ULL << 1)

struct ruleset_attr { uint64_t handled_access_fs, handled_access_net, scoped; };
struct path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));

#define STATUS_FD 3
#define FILE_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)

static void fail(const char *what, int error) {
  char line[512];
  int n = snprintf(line, sizeof line, "shell-sandbox: %s%s%s\n", what, error ? ": " : "", error ? strerror(error) : "");
  if (n > 0) { ssize_t ignored = write(STATUS_FD, line, (size_t)(n < (int)sizeof line ? n : (int)sizeof line - 1)); (void)ignored; }
  _exit(125);
}

static uint64_t handled_fs(long abi) {
  uint64_t mask = (FS_MAKE_SYM << 1) - 1; // ABI 1: EXECUTE … MAKE_SYM
  if (abi >= 2) mask |= FS_REFER;
  if (abi >= 3) mask |= FS_TRUNCATE;
  if (abi >= 5) mask |= FS_IOCTL_DEV;
  return mask;
}

static uint64_t class_rights(char cls) {
  switch (cls) {
    case 'x': return FS_READ_FILE | FS_READ_DIR | FS_EXECUTE;
    case 'r': return FS_READ_FILE | FS_READ_DIR;
    case 'l': return FS_READ_DIR;
    case 'd': return FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE | FS_IOCTL_DEV;
    case 'w': return FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG
      | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_SYM | FS_REFER | FS_TRUNCATE;
    default: return 0;
  }
}

static void add_rule(int ruleset, int root, char cls, const char *path, uint64_t handled) {
  uint64_t rights = class_rights(cls);
  if (!rights) fail("unknown rule class", 0);
  int fd;
  if (path[0] == '/') fd = open(path, O_PATH | O_CLOEXEC);
  else {
    struct open_how how = { .flags = O_PATH | O_CLOEXEC, .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    fd = (int)syscall(SYS_openat2, root, path, &how, sizeof how);
  }
  if (fd < 0) fail("cannot open a rule path", errno);
  struct stat st;
  if (fstat(fd, &st) != 0) fail("cannot inspect a rule path", errno);
  if ((S_ISCHR(st.st_mode) || S_ISBLK(st.st_mode)) && cls != 'd') fail("a device needs the device rule class", 0);
  if (!S_ISDIR(st.st_mode)) rights &= FILE_RIGHTS;
  rights &= handled;
  if (rights) {
    struct path_beneath_attr rule = { .allowed_access = rights, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0) != 0) fail("cannot add a rule", errno);
  }
  close(fd);
}

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#define X32_SYSCALL_BIT 0x40000000U
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#endif

#define LOAD(field) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, field))
#define ARG_LO(n) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[n]))
#define RET(value) BPF_STMT(BPF_RET | BPF_K, (value))
#define DENY(error) RET(SECCOMP_RET_ERRNO | ((error) & SECCOMP_RET_DATA))
/** System call `nr` whose argument `arg` carries MSG_FASTOPEN is refused, otherwise allowed (5 instructions, self-contained jumps). */
#define DENY_FASTOPEN(nr, arg) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 4), ARG_LO(arg), \
  BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, MSG_FASTOPEN, 0, 1), DENY(EACCES), RET(SECCOMP_RET_ALLOW)

/** Sockets: with the Landlock TCP rule (ABI >= 4) only AF_INET/AF_INET6 stream sockets of protocol 0/TCP reach the kernel, whose
 * connect/bind the Landlock network rule refuses; every other family and type (UDP, raw, unix — a unix socket reaches e.g. the
 * Docker daemon, which Landlock's filesystem rules do not cover —, netlink, vsock …) is refused here. Without it (ABI < 4) every
 * socket is refused. Two TCP paths the Landlock rule does not see (measured, ABI 7): `listen()` on an unbound socket binds an
 * ephemeral port and accepts connections, and `sendto`/`sendmsg`/`sendmmsg` with MSG_FASTOPEN connect without `connect()` —
 * both are refused. io_uring could open and connect sockets unseen by this filter: it is refused. Foreign-architecture system
 * calls end the process. */
static void install_seccomp(int tcp_by_landlock) {
#ifndef NATIVE_ARCH
  (void)tcp_by_landlock;
  fail("seccomp filter not available for this architecture", 0);
#else
  struct sock_filter filter[] = {
    LOAD(arch),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    RET(SECCOMP_RET_KILL_PROCESS),
    LOAD(nr),
#ifdef X32_SYSCALL_BIT
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, X32_SYSCALL_BIT, 0, 1),
    RET(SECCOMP_RET_KILL_PROCESS),
#endif
    // Landlock filesystem rights do not mediate chmod/chown. Deny metadata mutation globally:
    // an approved shell cannot make product authority writable for another process.
#ifdef SYS_chmod
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_chmod, 0, 1), DENY(EPERM),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fchmod, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fchmodat, 0, 1), DENY(EPERM),
#ifdef SYS_fchmodat2
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fchmodat2, 0, 1), DENY(EPERM),
#endif
#ifdef SYS_chown
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_chown, 0, 1), DENY(EPERM),
#endif
#ifdef SYS_lchown
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_lchown, 0, 1), DENY(EPERM),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fchown, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fchownat, 0, 1), DENY(EPERM),
    // POSIX ACLs and file capabilities are xattrs; they cannot reopen protected permissions either.
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setxattr, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_lsetxattr, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fsetxattr, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_removexattr, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_lremovexattr, 0, 1), DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fremovexattr, 0, 1), DENY(EPERM),
#ifdef SYS_setxattrat
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setxattrat, 0, 1), DENY(EPERM),
#endif
#ifdef SYS_removexattrat
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_removexattrat, 0, 1), DENY(EPERM),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
    DENY(EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_listen, 0, 1),
    DENY(EACCES),
    DENY_FASTOPEN(SYS_sendto, 3),
    DENY_FASTOPEN(SYS_sendmsg, 2),
    DENY_FASTOPEN(SYS_sendmmsg, 3),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 1, 0),
    RET(SECCOMP_RET_ALLOW),
    // socket(domain, type, protocol); without the Landlock TCP rule every socket is refused (jump to the refusal).
    BPF_JUMP(BPF_JMP | BPF_JA, tcp_by_landlock ? 0U : 9U, 0, 0),
    ARG_LO(0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_INET6, 0, 6),
    ARG_LO(1),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0xf), // SOCK_TYPE_MASK: SOCK_NONBLOCK / SOCK_CLOEXEC do not change the type
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 0, 3),
    ARG_LO(2),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, IPPROTO_TCP, 1, 0),
    DENY(EACCES),
    RET(SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof filter / sizeof filter[0]), .filter = filter };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) fail("cannot install the seccomp filter", errno);
#endif
}

int main(int argc, char **argv) {
  if (fcntl(STATUS_FD, F_SETFD, FD_CLOEXEC) != 0) _exit(125); // no status channel: nothing is reported and nothing runs
  long abi = -1;
  const char *root_path = NULL;
  int i = 1;
  for (; i + 1 < argc && strcmp(argv[i], "--") != 0; i += 2) {
    if (strcmp(argv[i], "--abi") == 0) { char *end; abi = strtol(argv[i + 1], &end, 10); if (*end || abi < 1) fail("invalid --abi", 0); }
    else if (strcmp(argv[i], "--root") == 0) root_path = argv[i + 1];
    else if (strcmp(argv[i], "--rule") == 0) i++; // class and path, applied below once the ruleset exists
    else fail("invalid arguments", 0);
  }
  if (i >= argc || strcmp(argv[i], "--") != 0 || i + 1 >= argc || abi < 1 || !root_path || root_path[0] != '/') fail("invalid arguments", 0);
  const int command = i + 1;

  const long kernel = syscall(SYS_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
  if (kernel < 1) fail("Landlock is not available", errno);
  if (kernel < abi) fail("the kernel's Landlock ABI is lower than requested", 0);
  const uint64_t fs = handled_fs(abi);
  struct ruleset_attr attr = { .handled_access_fs = fs, .handled_access_net = abi >= 4 ? NET_BIND_TCP | NET_CONNECT_TCP : 0,
    .scoped = abi >= 6 ? SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL : 0 };
  const size_t size = abi >= 6 ? sizeof attr : abi >= 4 ? offsetof(struct ruleset_attr, scoped) : offsetof(struct ruleset_attr, handled_access_net);
  const int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, size, 0);
  if (ruleset < 0) fail("cannot create the ruleset", errno);

  const int root = open(root_path, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root < 0) fail("cannot open the project root", errno);
  for (int j = 1; j < command - 1; j += 2) {
    if (strcmp(argv[j], "--rule") != 0) continue;
    if (strlen(argv[j + 1]) != 1) fail("invalid rule class", 0);
    add_rule(ruleset, root, argv[j + 1][0], argv[j + 2], fs);
    j++;
  }
  close(root);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("cannot set no_new_privs", errno);
  if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) fail("cannot enforce the ruleset", errno);
  close(ruleset);
  install_seccomp(abi >= 4);
  execvp(argv[command], &argv[command]);
  fail("cannot start the command", errno);
}
