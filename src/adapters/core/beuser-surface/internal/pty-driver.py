"""Private protocol v1. C2 executes this file only inside its admitted realm.

First line: trusted boot configuration. Subsequent lines: nonce-bound driver
requests, never executable paths or shell strings. Only replies go to stdout.
"""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from boot import read_boot


def positive(value):
    if type(value) is not int or value <= 0:
        raise ValueError()
    return value


def refuse_boot():
    sys.stdout.write('{"code":"BEUSER_SURFACE_INVALID"}\n')
    sys.stdout.flush()
    return 2


def main():
    boot_limit = positive(int(sys.argv[1]))
    boot_line = bytearray()
    while len(boot_line) <= boot_limit:
        byte = os.read(0, 1)
        if not byte:
            return refuse_boot()
        boot_line.extend(byte)
        if byte == b'\n':
            break
    if len(boot_line) > boot_limit or not boot_line.endswith(b'\n'):
        return refuse_boot()
    try:
        boot = read_boot(boot_line)
    except (ValueError, KeyError, TypeError, OSError, UnicodeError, RecursionError):
        return refuse_boot()
    nonce = boot['nonce']
    limits = boot['limits']
    for name in ('maxSteps', 'maxWallMs', 'maxWaitMs', 'maxTranscriptBytes',
                 'maxInputBytes', 'cleanupDeadlineMs', 'quietMs', 'inactivityMs'):
        positive(limits[name])
    if limits['quietMs'] > limits['inactivityMs'] or limits['inactivityMs'] > limits['maxWaitMs']:
        return
    columns, rows = positive(boot['columns']), positive(boot['rows'])
    if columns * rows * 4 > positive(boot['maxArtifactBytes']):
        return
    mode = boot['mode']
    if mode not in ('pty', 'argv') or not isinstance(nonce, str) or not nonce:
        return
    environment = boot['env']
    if not isinstance(environment, dict) or any(key not in ('TERM', 'LANG', 'LC_ALL', 'HOME', 'DECKENT_GLOBAL_HOME') for key in environment):
        return
    started = time.monotonic()
    deadline = started + limits['maxWallMs'] / 1000
    fd, pid, status = None, None, None
    pending = bytearray()
    raw_bytes, steps = 0, 0
    blocked, eof = False, False
    state = 'ready'

    def size():
        return struct.pack('HHHH', rows, columns, 0, 0)

    def launch(argv):
        nonlocal fd, pid, status, eof
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or '\0' in arg for arg in argv):
            raise ValueError()
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, size())
        child = os.fork()
        if child == 0:
            try:
                os.close(master)
                os.setsid()
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                for target in (0, 1, 2):
                    os.dup2(slave, target)
                os.closerange(3, os.sysconf('SC_OPEN_MAX'))
                os.execve(argv[0], argv, environment)
            except BaseException:
                os._exit(125)
        os.close(slave)
        os.set_blocking(master, False)
        fd, pid, status, eof = master, child, None, False

    def reap():
        nonlocal status
        if pid is not None and status is None:
            found, code = os.waitpid(pid, os.WNOHANG)
            if found:
                status = os.waitstatus_to_exitcode(code)

    def terminate():
        if pid is None:
            return
        # Kill the group even if its leader exited. C2 owns escaped descendants.
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        end = time.monotonic() + limits['cleanupDeadlineMs'] / 1000
        while time.monotonic() < end:
            reap()
            if status is not None:
                break
            time.sleep(min(limits['quietMs'] / 1000, max(0, end - time.monotonic())))
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        reap()
        if fd is not None:
            os.close(fd)

    def receive_output():
        nonlocal raw_bytes, state, eof
        if fd is None or eof:
            return False
        try:
            chunk = os.read(fd, min(limits['maxTranscriptBytes'] + 1, 65536))
        except BlockingIOError:
            return False
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b''
        if not chunk:
            eof = True
            reap()
            return False
        raw_bytes += len(chunk)
        if raw_bytes > limits['maxTranscriptBytes']:
            state = 'limit'
            pending.clear()
        elif not blocked:
            pending.extend(chunk)
        return True

    def drain(ms, until_exit=False, wait_full=False):
        nonlocal state
        end = min(deadline, time.monotonic() + ms / 1000)
        quiet_end = time.monotonic() + limits['quietMs'] / 1000
        while time.monotonic() < end and state == 'ready':
            reap()
            if eof:
                break
            wait_end = end if until_exit or wait_full else min(end, quiet_end)
            remaining = wait_end - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([fd], [], [], remaining)
            if readable and receive_output():
                quiet_end = time.monotonic() + limits['quietMs'] / 1000
        reap()
        if until_exit and (status is None or not eof) and state == 'ready':
            state = 'timeout'

    def reply(request_id):
        current = state if state != 'ready' else 'secret' if blocked else 'eof' if eof else 'ready'
        data = '' if blocked or current in ('invalid', 'limit', 'unavailable', 'timeout') else base64.b64encode(pending).decode('ascii')
        pending.clear()
        message = {'id': request_id, 'data': data, 'state': current,
                   'exitCode': status, 'columns': columns, 'rows': rows}
        sys.stdout.write(json.dumps(message, separators=(',', ':')) + '\n')
        sys.stdout.flush()

    def interrupt(_signum, _frame):
        raise InterruptedError()

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        if mode == 'pty':
            launch(boot['entry'])
        wire = bytearray()
        while time.monotonic() < deadline and state == 'ready':
            sources = [0] + ([fd] if fd is not None and not eof else [])
            ready, _, _ = select.select(sources, [], [], max(0, deadline - time.monotonic()))
            if fd is not None and fd in ready:
                receive_output()
            if 0 not in ready:
                continue
            chunk = os.read(0, min(limits['maxInputBytes'] * 2 + 1, 65536))
            if not chunk:
                break
            wire.extend(chunk)
            if len(wire) > limits['maxInputBytes'] * 2:
                break
            if b'\n' not in wire:
                continue
            # One outstanding request; a queued second request is invalid, never a new card's Enter.
            if wire.count(b'\n') != 1 or not wire.endswith(b'\n'):
                break
            command = json.loads(wire)
            wire.clear()
            request_id = positive(command['id'])
            steps += 1
            try:
                if command.get('nonce') != nonce:
                    raise ValueError()
                if steps > limits['maxSteps']:
                    state = 'limit'
                elif command.get('quietMs') != limits['quietMs'] or command.get('inactivityMs') != limits['inactivityMs']:
                    raise ValueError()
                elif command['op'] == 'secret':
                    blocked = True
                    pending.clear()
                    secret_fd = boot['secretFds'][command['ref']]
                    if type(secret_fd) is not int or secret_fd < 3:
                        raise ValueError()
                    os.set_blocking(secret_fd, False)
                    secret = os.read(secret_fd, limits['maxInputBytes'] + 1)
                    if not secret or len(secret) > limits['maxInputBytes'] or any(byte < 32 or byte == 127 for byte in secret):
                        raise ValueError()
                    attributes = termios.tcgetattr(fd)
                    attributes[3] &= ~(termios.ECHO | termios.ECHONL)
                    termios.tcsetattr(fd, termios.TCSANOW, attributes)
                    if os.write(fd, secret + b'\r') != len(secret) + 1:
                        raise ValueError()
                    del secret
                    os.close(secret_fd)
                    drain(limits['inactivityMs'])
                elif blocked:
                    pass
                elif command['op'] == 'argv':
                    if mode != 'argv' or pid is not None:
                        raise ValueError()
                    row = boot['commands'][command['commandId']]
                    if command['args'] not in row['allowedArgs']:
                        raise ValueError()
                    launch(row['prefix'] + command['args'])
                    drain(limits['maxWaitMs'], until_exit=True)
                elif command['op'] == 'input':
                    data = command['text'].encode('utf8')
                    if fd is None or eof or not data or len(data) > limits['maxInputBytes']:
                        raise ValueError()
                    if os.write(fd, data) != len(data):
                        raise ValueError()
                    drain(limits['inactivityMs'])
                elif command['op'] == 'resize':
                    columns, rows = positive(command['columns']), positive(command['rows'])
                    if columns * rows * 4 > boot['maxArtifactBytes'] or fd is None:
                        raise ValueError()
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, size())
                    drain(limits['inactivityMs'])
                elif command['op'] == 'read':
                    ms = positive(command['ms'])
                    if ms > limits['maxWaitMs'] or fd is None:
                        raise ValueError()
                    drain(ms, wait_full=True)
                else:
                    raise ValueError()
            except (KeyError, ValueError, TypeError, OSError):
                state = 'invalid'
            reply(request_id)
    finally:
        terminate()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError, InterruptedError):
        # Never include exceptions or configuration in diagnostics: both may hold target data.
        sys.exit(125)
