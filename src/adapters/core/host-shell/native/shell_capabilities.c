#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
  // VERSION is a query, never creates a ruleset or restricts the caller.
  errno = 0;
#ifdef SYS_landlock_create_ruleset
  const long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, 1U);
  const int landlock_errno = abi < 0 ? errno : 0;
#else
  const long abi = -1;
  const int landlock_errno = ENOSYS;
#endif
  // Only this short-lived helper enters a namespace. No mounts, network changes or commands.
  const int user_namespace = unshare(CLONE_NEWUSER) == 0;
  printf("{\"userNamespace\":%s,\"landlockAbi\":%ld,\"landlockErrno\":%d}\n",
    user_namespace ? "true" : "false", abi, landlock_errno);
  return 0;
}
