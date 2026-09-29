// SHELL-OVERLAY: lists an overlayfs upper directory after the sandboxed command ended, with the overlay metadata Node cannot read.
//
//   shell-overlay-scan <upper-dir> <max-entries>
//
// One record per entry below the root, depth first, written to stdout:
//   <type> <mode-octal> <nlink> <size> <rdev-major> <rdev-minor> <flags> <relative-path>\0
// type: f d l c b p s ?; flags: '-' or any of o (user.overlay.opaque = y|x), r (redirect), m (metacopy), w (whiteout xattr).
// The upper directory is Deckent's own (0700, outside every sandbox view) and the process that wrote it is gone, so the names read here
// were set by the kernel: an overlay-visible `user.overlay.X` set by the command is stored escaped (`user.overlay.overlay.X`) and is not
// reported. Nothing is followed (O_NOFOLLOW everywhere); depth > 32, more entries than the bound, or any error: one line on stderr,
// exit 2 (3 for the bound), and the caller refuses the whole set.
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/xattr.h>
#include <unistd.h>

#define MAX_DEPTH 32
#define PATH_BYTES 4096

static long max_entries, entries;

static void fail(const char *what, const char *path, int error, int code) {
  fprintf(stderr, "shell-overlay-scan: %s%s%s%s%s%s\n", what, path ? " (" : "", path ? path : "", path ? ")" : "", error ? ": " : "",
    error ? strerror(error) : "");
  exit(code);
}

/** Whether the entry carries the xattr, read through /proc/self/fd of the directory (no symbolic link is followed: lgetxattr). */
static int has(const char *proc, const char *name, char *value, size_t size) {
  ssize_t n = lgetxattr(proc, name, value, size);
  if (n >= 0) return (int)n + 1;
  if (errno == ENODATA || errno == ENOTSUP) return 0;
  fail("cannot read an overlay attribute", proc, errno, 2);
  return 0;
}

static char type_of(mode_t mode) {
  return S_ISREG(mode) ? 'f' : S_ISDIR(mode) ? 'd' : S_ISLNK(mode) ? 'l' : S_ISCHR(mode) ? 'c' : S_ISBLK(mode) ? 'b' : S_ISFIFO(mode) ? 'p' : S_ISSOCK(mode) ? 's' : '?';
}

static void walk(int dir, const char *rel, int depth) {
  if (depth > MAX_DEPTH) fail("deeper than the bound", rel, 0, 2);
  int copy = dup(dir);
  if (copy < 0) fail("cannot duplicate a directory", rel, errno, 2);
  DIR *listing = fdopendir(copy);
  if (!listing) fail("cannot list a directory", rel, errno, 2);
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(listing)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++entries > max_entries) fail("more entries than the bound", NULL, 0, 3);
    char path[PATH_BYTES];
    int n = snprintf(path, sizeof path, "%s%s%s", rel, *rel ? "/" : "", entry->d_name);
    if (n < 0 || n >= (int)sizeof path) fail("path too long", rel, 0, 2);
    struct stat st;
    if (fstatat(dir, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) fail("cannot inspect an entry", path, errno, 2);
    char proc[PATH_BYTES + 64];
    snprintf(proc, sizeof proc, "/proc/self/fd/%d/%s", dir, entry->d_name);
    char value[8] = { 0 };
    char flags[8]; int f = 0;
    int opaque = has(proc, "user.overlay.opaque", value, sizeof value - 1);
    if (opaque > 1 && (value[0] == 'y' || value[0] == 'x')) flags[f++] = 'o';
    if (has(proc, "user.overlay.redirect", NULL, 0)) flags[f++] = 'r';
    if (has(proc, "user.overlay.metacopy", NULL, 0)) flags[f++] = 'm';
    if (has(proc, "user.overlay.whiteout", NULL, 0)) flags[f++] = 'w';
    if (!f) flags[f++] = '-';
    flags[f] = '\0';
    printf("%c %o %lu %lld %u %u %s %s", type_of(st.st_mode), (unsigned)(st.st_mode & 07777), (unsigned long)st.st_nlink, (long long)st.st_size,
      major(st.st_rdev), minor(st.st_rdev), flags, path);
    putchar('\0');
    if (S_ISDIR(st.st_mode)) {
      int child = openat(dir, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) fail("cannot open a directory", path, errno, 2);
      walk(child, path, depth + 1);
      close(child);
    }
    errno = 0;
  }
  if (errno) fail("cannot list a directory", rel, errno, 2);
  closedir(listing);
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/') fail("usage: shell-overlay-scan <absolute upper dir> <max entries>", NULL, 0, 2);
  char *end;
  max_entries = strtol(argv[2], &end, 10);
  if (*end || max_entries <= 0) fail("invalid bound", NULL, 0, 2);
  int root = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0) fail("cannot open the upper directory", argv[1], errno, 2);
  walk(root, "", 0);
  if (fflush(stdout) != 0) fail("cannot write the listing", NULL, errno, 2);
  return 0;
}
