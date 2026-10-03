#pragma once
#include <cstdlib>
#include <vector>
#include <linux/fs.h>

namespace {
struct OwnedPath { std::string path; struct stat identity{}; int identity_fd = -1; };
bool same_identity(const struct stat& current, const struct stat& pinned) {
  return current.st_uid == pinned.st_uid && current.st_dev == pinned.st_dev && current.st_ino == pinned.st_ino;
}
int remove_owned(const OwnedPath& owned) {
  struct stat current{};
  if (lstat(owned.path.c_str(), &current) != 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISSOCK(current.st_mode) || !same_identity(current, owned.identity)) return -1;
  return unlink(owned.path.c_str());
}

// Same-filesystem staging. Keep both directories pinned; never recurse or delete a replacement.
struct SocketStagingDirectory {
  std::string path, name;
  struct stat identity{};
  int parent_fd = -1, fd = -1;
  bool ready = false;
  explicit SocketStagingDirectory(const std::string& parent) {
    parent_fd = open(parent.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent_fd < 0) return;
    const auto pattern = (parent == "/" ? "" : parent) + "/.sXXXXXX";
    std::vector<char> bytes(pattern.begin(), pattern.end()); bytes.push_back('\0');
    if (!mkdtemp(bytes.data())) return;
    path = bytes.data(); name = path.substr(path.find_last_of('/') + 1);
    fd = openat(parent_fd, name.c_str(), O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    ready = fd >= 0 && fstat(fd, &identity) == 0 && S_ISDIR(identity.st_mode)
      && identity.st_uid == getuid() && (identity.st_mode & 07777) == 0700;
  }
  ~SocketStagingDirectory() {
    struct stat current{};
    if (fd >= 0 && fstatat(parent_fd, name.c_str(), &current, AT_SYMLINK_NOFOLLOW) == 0
        && S_ISDIR(current.st_mode) && same_identity(current, identity))
      unlinkat(parent_fd, name.c_str(), AT_REMOVEDIR); // empty and exact identity only
    if (fd >= 0) ::close(fd);
    if (parent_fd >= 0) ::close(parent_fd);
  }
};

const char* publish_private_socket(int fd, const std::string& published, int backlog, OwnedPath& owned, int fault) {
  const auto slash = published.find_last_of('/');
  const auto parent = slash == 0 ? "/" : published.substr(0, slash);
  // '/.sXXXXXX/s' is 11 bytes. Refuse before creating anything, including the trailing NUL budget.
  if ((parent == "/" ? 0 : parent.size()) + 11 >= sizeof(sockaddr_un::sun_path)) return "LOCAL_PEER_OPTIONS";
  SocketStagingDirectory staging(parent);
  if (!staging.ready) return "LOCAL_PEER_CUSTODY";
  sockaddr_un address{}; address.sun_family = AF_UNIX;
  owned.path = staging.path + "/s";
  std::memcpy(address.sun_path, owned.path.c_str(), owned.path.size() + 1);
  if (bind(fd, reinterpret_cast<sockaddr*>(&address), offsetof(sockaddr_un, sun_path) + owned.path.size() + 1) != 0)
    return "LOCAL_PEER_LISTEN";
  // fstat(socket_fd) is a sockfs identity. Pin the actual filesystem inode instead.
  owned.identity_fd = openat(staging.fd, "s", O_PATH | O_NOFOLLOW | O_CLOEXEC);
  const bool pinned = owned.identity_fd >= 0 && fstat(owned.identity_fd, &owned.identity) == 0
    && S_ISSOCK(owned.identity.st_mode) && owned.identity.st_uid == getuid();
  const auto refuse = [&](const char* code) {
    struct stat current{};
    if (pinned && fstatat(staging.fd, "s", &current, AT_SYMLINK_NOFOLLOW) == 0
        && S_ISSOCK(current.st_mode) && same_identity(current, owned.identity)) unlinkat(staging.fd, "s", 0);
    if (owned.identity_fd >= 0) ::close(owned.identity_fd);
    owned.identity_fd = -1; return code;
  };
  if (!pinned) return refuse("LOCAL_PEER_CUSTODY");
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  if (fault == 8) {
    unlinkat(staging.fd, "s", 0);
    const int replacement = openat(staging.fd, "s", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0640);
    if (replacement < 0) return refuse("LOCAL_PEER_TEST_SETUP");
    const char bytes[] = "replacement";
    const auto written = write(replacement, bytes, sizeof(bytes) - 1); ::close(replacement);
    if (written != sizeof(bytes) - 1) return refuse("LOCAL_PEER_TEST_SETUP");
  }
  if (fault == 9) {
    if (renameat(staging.parent_fd, staging.name.c_str(), staging.parent_fd, (staging.name + ".held").c_str()) != 0
        || mkdirat(staging.parent_fd, staging.name.c_str(), 0700) != 0) return refuse("LOCAL_PEER_TEST_SETUP");
    return refuse("LOCAL_PEER_CUSTODY");
  }
  if (fault == 11) {
    unlinkat(staging.fd, "s", 0);
    const int replacement = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (replacement < 0) return refuse("LOCAL_PEER_TEST_SETUP");
    const int bound = bind(replacement, reinterpret_cast<sockaddr*>(&address), offsetof(sockaddr_un, sun_path) + owned.path.size() + 1);
    ::close(replacement);
    if (bound != 0) return refuse("LOCAL_PEER_TEST_SETUP");
  }
#else
  (void)fault;
#endif
  // O_PATH cannot be fchmod'ed; Linux /proc/self/fd resolves the pinned inode, not a replaceable name.
  const auto pinned_path = "/proc/self/fd/" + std::to_string(owned.identity_fd);
  struct stat private_identity{};
  if (fault == 5 || chmod(pinned_path.c_str(), 0600) != 0 || fstat(owned.identity_fd, &private_identity) != 0
      || !S_ISSOCK(private_identity.st_mode) || !same_identity(private_identity, owned.identity)
      || (private_identity.st_mode & 07777) != 0600) return refuse("LOCAL_PEER_CUSTODY");
  if (fault == 7 || listen(fd, backlog) != 0) return refuse("LOCAL_PEER_LISTEN");
  struct stat source{};
  if (fstatat(staging.fd, "s", &source, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISSOCK(source.st_mode)
      || !same_identity(source, owned.identity) || (source.st_mode & 07777) != 0600) return refuse("LOCAL_PEER_CUSTODY");
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  if (fault == 10) {
    const int sentinel = openat(staging.parent_fd, published.substr(slash + 1).c_str(), O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (sentinel < 0) return refuse("LOCAL_PEER_TEST_SETUP");
    const char bytes[] = "sentinel";
    const auto written = write(sentinel, bytes, sizeof(bytes) - 1); ::close(sentinel);
    if (written != sizeof(bytes) - 1) return refuse("LOCAL_PEER_TEST_SETUP");
  }
#endif
  // No overwrite and no check-then-rename fallback. Only a private listening socket is published.
  int renamed;
  if (fault == 6 || fault == 12 || fault == 13) {
    errno = fault == 12 ? ENOSYS : fault == 13 ? EINVAL : EOPNOTSUPP; renamed = -1;
  }
  else renamed = renameat2(staging.fd, "s", staging.parent_fd, published.substr(slash + 1).c_str(), RENAME_NOREPLACE);
  if (renamed != 0) {
    const int error = errno;
    return refuse(error == EINVAL || error == ENOSYS || error == EOPNOTSUPP ? "LOCAL_PEER_PUBLICATION_UNSUPPORTED"
      : error == EEXIST ? "LOCAL_PEER_LISTEN" : "LOCAL_PEER_CUSTODY");
  }
  owned.path = published;
  return nullptr;
}
} // namespace
