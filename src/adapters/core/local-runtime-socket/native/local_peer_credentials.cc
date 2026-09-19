#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <node_api.h>
#include <uv.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#include <cerrno>
#include <cstring>
#include <cmath>
#include <climits>

namespace {
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
thread_local int next_start_fault = 0;
#endif
struct OwnedPath { std::string path; struct stat identity{}; int identity_fd = -1; };
int remove_owned(const OwnedPath& owned) {
  struct stat current{};
  if (lstat(owned.path.c_str(), &current) != 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISSOCK(current.st_mode) || current.st_uid != owned.identity.st_uid
      || current.st_dev != owned.identity.st_dev || current.st_ino != owned.identity.st_ino) return -1;
  return unlink(owned.path.c_str());
}

napi_value fail(napi_env env, const char* code) {
  napi_throw_error(env, code, code);
  return nullptr;
}
struct Handoff { int fd; bool active = true; };
void release_handoff(napi_env, void* data, void*) { delete static_cast<Handoff*>(data); }
napi_value take_fd(napi_env env, napi_callback_info info) {
  void* data = nullptr; size_t count = 0;
  napi_get_cb_info(env, info, &count, nullptr, nullptr, &data);
  auto* handoff = static_cast<Handoff*>(data);
  if (!handoff->active || handoff->fd < 0) return fail(env, "LOCAL_PEER_TRANSFERRED");
  napi_value result;
  if (napi_create_int32(env, handoff->fd, &result) != napi_ok) return fail(env, "LOCAL_PEER_TRANSFER");
  handoff->fd = -1;
  return result;
}
struct Listener {
  napi_env env;
  OwnedPath endpoint;
  napi_ref self = nullptr;
  napi_ref callback = nullptr;
  napi_ref lifecycle = nullptr;
  const char* reason = "requested";
  napi_async_cleanup_hook_handle cleanup = nullptr;
  uv_poll_t poll{};
  int fd = -1;
  bool closing = false;
  bool closed = false;
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  int fault = 0;
#endif
};
void stop(Listener* listener, const char* reason = "requested");
void finalize(napi_env, void* data, void*) {
  auto* listener = static_cast<Listener*>(data);
  if (listener->endpoint.identity_fd >= 0) ::close(listener->endpoint.identity_fd);
  delete listener;
}
void closed(uv_handle_t* handle) {
  auto* listener = static_cast<Listener*>(handle->data);
  if (listener->fd >= 0) { ::close(listener->fd); listener->fd = -1; }
  listener->closed = true;
  if (listener->lifecycle && std::strcmp(listener->reason, "environment-cleanup") != 0) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(listener->env, &scope) == napi_ok) {
      napi_value callback, global, event, state, reason, result;
      napi_get_reference_value(listener->env, listener->lifecycle, &callback);
      napi_get_global(listener->env, &global); napi_create_object(listener->env, &event);
      napi_create_string_utf8(listener->env, "closed", NAPI_AUTO_LENGTH, &state);
      napi_create_string_utf8(listener->env, listener->reason, NAPI_AUTO_LENGTH, &reason);
      napi_set_named_property(listener->env, event, "state", state);
      napi_set_named_property(listener->env, event, "reason", reason);
      napi_object_freeze(listener->env, event);
      if (napi_call_function(listener->env, global, callback, 1, &event, &result) == napi_pending_exception) {
        napi_value ignored; napi_get_and_clear_last_exception(listener->env, &ignored);
      }
      napi_close_handle_scope(listener->env, scope);
    }
  }
  if (listener->lifecycle) { napi_delete_reference(listener->env, listener->lifecycle); listener->lifecycle = nullptr; }
  if (listener->callback) { napi_delete_reference(listener->env, listener->callback); listener->callback = nullptr; }
  if (listener->cleanup) { napi_remove_async_cleanup_hook(listener->cleanup); listener->cleanup = nullptr; }
  // The wrapper owns memory. Release its strong reference only after libuv stops using it.
  if (listener->self) { napi_delete_reference(listener->env, listener->self); listener->self = nullptr; }
}
void stop(Listener* listener, const char* reason) {
  if (listener->closing) return;
  listener->closing = true;
  listener->reason = reason;
  uv_poll_stop(&listener->poll);
  uv_close(reinterpret_cast<uv_handle_t*>(&listener->poll), closed);
}
void cleanup(napi_async_cleanup_hook_handle, void* data) { stop(static_cast<Listener*>(data), "environment-cleanup"); }
napi_value close_listener(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self; Listener* listener = nullptr;
  napi_get_cb_info(env, info, &count, nullptr, &self, nullptr);
  if (napi_unwrap(env, self, reinterpret_cast<void**>(&listener)) != napi_ok || !listener)
    return fail(env, "LOCAL_PEER_RECEIVER");
  stop(listener);
  napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value remove_endpoint(napi_env env, napi_callback_info info) {
  size_t count = 0; napi_value self; Listener* listener = nullptr;
  napi_get_cb_info(env, info, &count, nullptr, &self, nullptr);
  if (napi_unwrap(env, self, reinterpret_cast<void**>(&listener)) != napi_ok || !listener)
    return fail(env, "LOCAL_PEER_RECEIVER");
  if (!listener->closed) return fail(env, "LOCAL_PEER_ACTIVE");
  if (listener->endpoint.identity_fd >= 0) {
    if (remove_owned(listener->endpoint) != 0) return fail(env, "LOCAL_PEER_CUSTODY");
    ::close(listener->endpoint.identity_fd); listener->endpoint.identity_fd = -1;
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
void deliver(Listener* listener, int fd, const ucred& credential) {
  napi_handle_scope scope;
  if (napi_open_handle_scope(listener->env, &scope) != napi_ok) { ::close(fd); return; }
  napi_env env = listener->env;
  auto* handoff = new Handoff{fd};
  napi_value callback, global, arg, peer, value, take, result;
  napi_get_reference_value(env, listener->callback, &callback);
  napi_get_global(env, &global);
  napi_create_object(env, &arg); napi_create_object(env, &peer);
  napi_create_int32(env, credential.pid, &value); napi_set_named_property(env, peer, "pid", value);
  napi_create_uint32(env, credential.uid, &value); napi_set_named_property(env, peer, "uid", value);
  napi_create_uint32(env, credential.gid, &value); napi_set_named_property(env, peer, "gid", value);
  napi_object_freeze(env, peer); napi_set_named_property(env, arg, "peer", peer);
  napi_create_function(env, "takeFd", NAPI_AUTO_LENGTH, take_fd, handoff, &take);
  // A detached saved takeFd function also retains its heap state, never a stack pointer.
  napi_add_finalizer(env, take, handoff, release_handoff, nullptr, nullptr);
  napi_set_named_property(env, arg, "takeFd", take); napi_object_freeze(env, arg);
  const auto status = napi_call_function(env, global, callback, 1, &arg, &result);
  handoff->active = false;
  if (handoff->fd >= 0) { ::close(handoff->fd); handoff->fd = -1; }
  if (status == napi_pending_exception) { napi_value exception; napi_get_and_clear_last_exception(env, &exception); }
  napi_close_handle_scope(env, scope);
}
void readable(uv_poll_t* poll, int status, int events) {
  auto* listener = static_cast<Listener*>(poll->data);
  if (listener->closing) return;
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  const int fault = listener->fault; listener->fault = 0;
  if (fault == 1) status = UV_EBADF;
#else
  constexpr int fault = 0;
#endif
  if (status < 0 || !(events & UV_READABLE)) { stop(listener, "poll-failed"); return; }
  // Bound event-loop work per readiness notification; remaining connections stay queued.
  for (int batch = 0; batch < 64 && !listener->closing; ++batch) {
    int fd;
    if (fault == 2) { errno = EMFILE; fd = -1; }
    else fd = accept4(listener->fd, nullptr, nullptr, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) {
      if (errno == EINTR) continue;
      if (errno != EAGAIN && errno != EWOULDBLOCK) stop(listener, "accept-failed");
      break;
    }
    ucred credential{}; socklen_t length = sizeof(credential);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credential, &length) != 0 || length != sizeof(credential)) {
      ::close(fd); continue;
    }
    deliver(listener, fd, credential);
  }
}
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
napi_value fail_next_readable(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg, self; Listener* listener = nullptr; int32_t mode = 0;
  napi_get_cb_info(env, info, &count, &arg, &self, nullptr);
  if (count != 1 || napi_get_value_int32(env, arg, &mode) != napi_ok || mode < 1 || mode > 2
      || napi_unwrap(env, self, reinterpret_cast<void**>(&listener)) != napi_ok || !listener || listener->closing)
    return fail(env, "LOCAL_PEER_TEST_OPTIONS");
  listener->fault = mode; napi_value result; napi_get_undefined(env, &result); return result;
}
napi_value fail_next_start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg; int32_t mode = 0;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  if (count != 1 || napi_get_value_int32(env, arg, &mode) != napi_ok || mode < 1 || mode > 3)
    return fail(env, "LOCAL_PEER_TEST_OPTIONS");
  next_start_fault = mode; napi_value result; napi_get_undefined(env, &result); return result;
}
#endif
napi_value create_listener(napi_env env, napi_callback_info info) {
  size_t count = 4; napi_value args[4]; napi_valuetype type;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  size_t length = 0; double backlog = 0;
  if (count != 4 || napi_typeof(env, args[2], &type) != napi_ok || type != napi_function
      || napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok
      || napi_typeof(env, args[3], &type) != napi_ok || type != napi_function
      || !length || length >= sizeof(sockaddr_un::sun_path)
      || napi_get_value_double(env, args[1], &backlog) != napi_ok || !std::isfinite(backlog)
      || backlog < 1 || backlog > INT_MAX || backlog != std::floor(backlog)) return fail(env, "LOCAL_PEER_OPTIONS");
  sockaddr_un address{}; address.sun_family = AF_UNIX;
  napi_get_value_string_utf8(env, args[0], address.sun_path, sizeof(address.sun_path), &length);
  if (address.sun_path[0] != '/' || std::strlen(address.sun_path) != length) return fail(env, "LOCAL_PEER_OPTIONS");
  uv_loop_t* loop = nullptr;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok) return fail(env, "LOCAL_PEER_LOOP");
  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (fd < 0) return fail(env, "LOCAL_PEER_SOCKET");
  // Capture pathname identity after our successful bind, not fstat(socket_fd)'s sockfs inode.
  // The owning TS adapter has already validated/guarded the private parent directory.
  if (bind(fd, reinterpret_cast<sockaddr*>(&address), offsetof(sockaddr_un, sun_path) + length + 1) != 0) {
    ::close(fd); return fail(env, "LOCAL_PEER_LISTEN");
  }
  OwnedPath owned{address.sun_path};
  // Pin the filesystem inode until custody ends; dev+ino alone can be reused after unlink.
  owned.identity_fd = open(address.sun_path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (owned.identity_fd < 0 || fstat(owned.identity_fd, &owned.identity) != 0
      || !S_ISSOCK(owned.identity.st_mode) || owned.identity.st_uid != getuid()) {
    if (owned.identity_fd >= 0) ::close(owned.identity_fd);
    ::close(fd); return fail(env, "LOCAL_PEER_CUSTODY");
  }
  if (listen(fd, static_cast<int>(backlog)) != 0) {
    remove_owned(owned); ::close(owned.identity_fd); ::close(fd); return fail(env, "LOCAL_PEER_LISTEN");
  }
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  const int start_fault = next_start_fault; next_start_fault = 0;
  if (start_fault == 3) {
    unlink(address.sun_path);
    const int replacement = open(address.sun_path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (replacement >= 0) {
      const char bytes[] = "replacement"; const auto written = write(replacement, bytes, sizeof(bytes) - 1);
      ::close(replacement);
      if (written != sizeof(bytes) - 1) { ::close(owned.identity_fd); ::close(fd); return fail(env, "LOCAL_PEER_TEST_SETUP"); }
    }
  }
#else
  constexpr int start_fault = 0;
#endif
  auto* listener = new Listener{env, owned}; listener->fd = fd;
  if (start_fault == 1 || start_fault == 3 || uv_poll_init_socket(loop, &listener->poll, fd) != 0) {
    remove_owned(owned); ::close(owned.identity_fd); ::close(fd); delete listener; return fail(env, "LOCAL_PEER_POLL");
  }
  listener->poll.data = listener;
  napi_value object; napi_create_object(env, &object);
  napi_wrap(env, object, listener, finalize, nullptr, nullptr);
  napi_create_reference(env, object, 1, &listener->self);
  napi_create_reference(env, args[2], 1, &listener->callback);
  napi_create_reference(env, args[3], 1, &listener->lifecycle);
  napi_add_async_cleanup_hook(env, cleanup, listener, &listener->cleanup);
  napi_property_descriptor method = {"close", nullptr, close_listener, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, object, 1, &method);
  napi_property_descriptor removal = {"removeEndpoint", nullptr, remove_endpoint, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, object, 1, &removal);
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  napi_property_descriptor injection = {"__testFailNextReadable", nullptr, fail_next_readable, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, object, 1, &injection);
#endif
  if (start_fault == 2 || uv_poll_start(&listener->poll, UV_READABLE, readable) != 0) {
    remove_owned(owned);
    // No wrapper is returned on failed startup: release inode custody now, not at a later GC.
    ::close(listener->endpoint.identity_fd); listener->endpoint.identity_fd = -1;
    stop(listener); return fail(env, "LOCAL_PEER_POLL");
  }
  return object;
}
}
NAPI_MODULE_INIT() {
  napi_property_descriptor method = {"createListener", nullptr, create_listener, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &method);
#ifdef DECKENT_LOCAL_PEER_TEST_FAULTS
  napi_property_descriptor injection = {"__testFailNextStart", nullptr, fail_next_start, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &injection);
#endif
  return exports;
}
