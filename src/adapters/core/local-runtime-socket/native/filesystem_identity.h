#include <sys/vfs.h>
#include <cstdio>

// One statfs observation of an opened directory. No udev, subprocess, retry or raw UUID read.
static napi_value filesystem_identity(napi_env env, napi_callback_info info) {
  size_t count = 1, length = 0; napi_value arg;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  char path[PATH_MAX];
  if (count != 1 || napi_get_value_string_utf8(env, arg, nullptr, 0, &length) != napi_ok || !length || length >= sizeof(path)
      || napi_get_value_string_utf8(env, arg, path, sizeof(path), &length) != napi_ok || path[0] != '/' || std::strlen(path) != length) {
    napi_throw_error(env, "FILESYSTEM_IDENTITY_PATH", "FILESYSTEM_IDENTITY_PATH"); return nullptr;
  }
  const int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  struct stat dir{}; struct statfs fs{};
  const bool ok = fd >= 0 && fstat(fd, &dir) == 0 && S_ISDIR(dir.st_mode) && fstatfs(fd, &fs) == 0;
  if (fd >= 0) close(fd);
  napi_value result;
  if (!ok) { napi_get_null(env, &result); return result; }
  napi_create_object(env, &result);
  napi_value value; napi_create_double(env, static_cast<double>(fs.f_type), &value); napi_set_named_property(env, result, "type", value);
  // Canonical word[0] / word[1] hex (GNU stat %i order), independent of signed int representation.
  char fsid[17]; std::snprintf(fsid, sizeof(fsid), "%08x%08x", static_cast<unsigned>(fs.f_fsid.__val[0]), static_cast<unsigned>(fs.f_fsid.__val[1]));
  napi_create_string_utf8(env, fsid, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "fsid", value);
  const auto device = std::to_string(dir.st_dev), inode = std::to_string(dir.st_ino);
  napi_create_string_utf8(env, device.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "device", value);
  napi_create_string_utf8(env, inode.c_str(), NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "inode", value);
  return result;
}
