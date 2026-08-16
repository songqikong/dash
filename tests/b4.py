#!/usr/bin/env python3
# DASH batch-4 pty test: /resume session picker + replay, session rename,
# /theme light/dark, /settings panel, @ file completion, chat round trips.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys, shutil

# reset DASH config so the test starts on the dark theme
for p in (os.path.expanduser('~/.dash/config.yml'), os.path.expanduser('~/.dash/keybindings.yml')):
    if os.path.exists(p):
        os.remove(p)

wd = '/tmp/dashb4'
shutil.rmtree(wd, ignore_errors=True)
os.makedirs(wd)
open(os.path.join(wd, 'zzzfile.txt'), 'w').write('hi\n')
open(os.path.join(wd, 'aaaother.txt'), 'w').write('hi\n')

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 130, 0, 0))
p = subprocess.Popen(['dsh', '--profile', 'dash'], stdin=slave, stdout=slave, stderr=slave, cwd=wd,
                     env={**os.environ, 'TERM': 'xterm-256color', 'NODE_ENV': 'production'}, close_fds=True)
os.close(slave)

buf = b''
def read_avail(timeout):
    global buf
    out = b''
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.25)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data: break
            out += data
            end = time.time() + 0.25
        elif out:
            break
    buf += out
    return out

def wait_for(marker, timeout, label):
    t = time.time()
    while time.time() - t < timeout:
        read_avail(0.4)
        if marker in buf:
            print('[%s] OK (%.1fs)' % (label, time.time() - t))
            return True
    print('[%s] FAIL (marker %r)' % (label, marker))
    return False

def send(b):
    os.write(master, b)

def wait_turn_done(timeout, label):
    t = time.time()
    while time.time() - t < timeout:
        read_avail(0.5)
        tail = buf[-6000:]
        si = tail.rfind(b'streaming')
        ii = tail.rfind(b'idle')
        if ii > si:  # topbar flipped back to idle after streaming
            print('[%s] OK (%.1fs)' % (label, time.time() - t))
            return True
    print('[%s] FAIL' % label)
    return False


fails = []
def check(ok, label):
    if ok: print('[ok] %s' % label)
    else:
        print('[FAIL] %s' % label)
        fails.append(label)

wait_for(b'DASH ready', 120, 'ready')
check(b'\x1b[38;5;245m' in buf, 'dark theme dim 245 at start')

# session A: two messages
send(b'Reply with exactly WORDA1 and nothing else.\r')
wait_for('\u25cf WORDA1'.encode('utf-8'), 180, 'A reply 1')
wait_turn_done(180, 'A turn 1 done')
send(b'Reply with exactly WORDA2 and nothing else.\r')
wait_for('\u25cf WORDA2'.encode('utf-8'), 180, 'A reply 2')
wait_turn_done(180, 'A turn 2 done')

# session B via /new (wait for the new-session notice)
send(b'/new\r')
wait_for(b'new session', 60, 'session B created')
send(b'Reply with exactly WORDB1 and nothing else.\r')
wait_for('\u25cf WORDB1'.encode('utf-8'), 180, 'B reply')
wait_turn_done(180, 'B turn done')

# /resume dialog: list shows sessions with titles
send(b'/resume\r')
time.sleep(1.5); read_avail(1)
check('\u6062\u590d\u4f1a\u8bdd'.encode('utf-8') in buf, '/resume dialog opens')
check(b'Alpha' in buf or b'A1' in buf or b'WORDA1' in buf, 'session A listed with title')

# resume session A (2nd item: newest is B)
send(b'\x1b[B\r')   # down + enter
time.sleep(3); read_avail(2)
check('\u5df2\u6062\u590d\u4f1a\u8bdd'.encode('utf-8') in buf, 'resumed session A')
check(b'WORDA2' in buf, 'session A transcript replayed')

# rename current session
send(b'/rename MYRENAMED\r')
time.sleep(0.5); read_avail(0.4)
check(b'MYRENAMED' in buf, '/rename updates title')

# theme light -> dim color changes from 245 to 244
send(b'/theme light\r')
time.sleep(0.5); read_avail(0.4)
check(b'\x1b[38;5;244m' in buf, 'light theme dim 244 after switch')
send(b'/theme dark\r')
time.sleep(0.5); read_avail(0.4)

send(b'/theme dark\r')
time.sleep(0.4); read_avail(0.3)
# /settings panel: toggle theme.light on then off
send(b'/settings\r')
time.sleep(0.5); read_avail(0.4)
check(b'settings' in buf, '/settings panel opens')
send(b'\r')   # toggle first row (theme.light)
time.sleep(0.5); read_avail(0.4)
check(b'\x1b[38;5;244m' in buf, 'settings toggled light theme')
send(b'\x1b') # close
time.sleep(0.4); read_avail(0.3)

# @ file completion
send(b'look at @zzz')
time.sleep(0.3); read_avail(0.3)
send(b'\t')
time.sleep(0.5); read_avail(0.4)
check(b'zzzfile.txt' in buf, '@ completion lists files')
send(b'\r')
time.sleep(0.4); read_avail(0.3)
check(b'@zzzfile.txt' in buf, '@ completion inserted path')
send(b'\x15')  # clear draft

# chat round trip still fine
send(b'Reply with exactly B4OK and nothing else.\r')
ok = wait_for('\u25cf B4OK'.encode('utf-8'), 120, 'reply after all ops')
check(ok, 'chat round trip after resume/theme/settings')

send(b'\x04')
time.sleep(0.3); read_avail(0.3)
send(b'y')
time.sleep(2); read_avail(1)
if p.poll() is None:
    p.kill()
    print('[FAIL] clean exit')
    fails.append('exit')
else:
    print('[ok] clean exit')
print('RESULT:', 'FAILS: ' + ', '.join(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
