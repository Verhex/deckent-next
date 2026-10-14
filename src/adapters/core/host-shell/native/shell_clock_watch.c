// SHELL-OVERLAY clock watch (CI-KARARLILIK, Astra 2555 R1): whether the realtime clock was set at any moment of a sandboxed call.
//
//   shell-clock-watch
//
// Arms a CLOCK_REALTIME timerfd with TFD_TIMER_CANCEL_ON_SET, writes "armed\n" to stdout, waits for stdin to reach end of file, then writes
// "steady\n" (the realtime clock was not set since arming) or "stepped\n" (it was set at least once: settimeofday, clock_settime, adjtimex
// ADJ_SETOFFSET, a hypervisor time sync). The kernel marks the timer at each set, so a step back followed by a step forward still counts;
// slewing (a frequency adjustment) does not set the clock and is not reported. Any error: one line on stderr, exit 2.
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

static void fail(const char *what) {
  fprintf(stderr, "shell-clock-watch: %s: %s\n", what, strerror(errno));
  exit(2);
}

static void say(const char *line) {
  size_t length = strlen(line);
  if (write(STDOUT_FILENO, line, length) != (ssize_t)length) fail("cannot write the answer");
}

int main(void) {
  int timer = timerfd_create(CLOCK_REALTIME, TFD_CLOEXEC | TFD_NONBLOCK);
  if (timer < 0) fail("cannot create the timer");
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) fail("cannot read the clock");
  // Ten years ahead: never reached by an elapsed call; a forward jump past it reads as an expiry, also reported as a step.
  struct itimerspec at = { .it_interval = { 0, 0 }, .it_value = { now.tv_sec + 10L * 366 * 24 * 3600, 0 } };
  if (timerfd_settime(timer, TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET, &at, NULL) != 0) fail("cannot arm the timer");
  say("armed\n");
  char ignored[256];
  for (;;) {
    ssize_t n = read(STDIN_FILENO, ignored, sizeof ignored);
    if (n == 0) break;
    if (n < 0 && errno != EINTR) fail("cannot read stdin");
  }
  uint64_t expirations;
  ssize_t n = read(timer, &expirations, sizeof expirations);
  if (n < 0 && errno == ECANCELED) say("stepped\n");
  else if (n < 0 && errno == EAGAIN) say("steady\n");
  else if (n == (ssize_t)sizeof expirations) say("stepped\n");
  else fail("cannot read the timer");
  return 0;
}
