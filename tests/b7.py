#!/usr/bin/env python3
# DASH batch-7 pty test: omp-style welcome splash at startup + mouse wheel
# scrolling (SGR mouse), splash disappears after the first message.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys

# seed the zh UI language so the Chinese assertions below hold
open(os.path.expanduser('~/.dash/config.yml'), 'w').write('lang: zh\n')

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 132, 0, 0))
p = subprocess.Popen(['dsh', '--profile', 'dash'], stdin=slave, stdout=slave, stderr=slave,
                     env={**os.environ, 'TERM': 'xterm-256color', 'NODE_ENV': 'production'}, close_fds=True)
os.close(slave)

buf = b''
def read_avail(timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if r:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
    return buf

def wait_for(marker, timeout, label):
    t = time.time()
    while time.time() - t < timeout:
        if marker in buf:
            return True
        read_avail(0.3)
    return False

def send(b):
    os.write(master, b)

fails = []
def check(ok, label):
    if ok: print('[ok] %s' % label)
    else:
        print('[FAIL] %s' % label)
        fails.append(label)

# ── welcome splash at startup (omp-style frame) ──
ok = wait_for(b'Welcome back!', 60, 'splash')
check(ok, 'welcome splash shows at startup')
check(b'DASH v0.2.0' in buf, 'splash title DASH v0.2.0')
check('█▀▀▀▀▀▀█  ▄▀▀▀▀▀▀▄'.encode('utf-8') in buf, 'DASH wordmark rendered')
check(b'\xe2\x94\x8c' in buf, 'sharp box corners (┌)')
check('\u256d'.encode('utf-8') not in buf, 'no rounded corners (╭)')
check(b'Recent sessions' in buf, 'recent sessions panel')
check(b'Agent preset' in buf, 'agent preset panel')
check(b'Tips' in buf, 'tips panel')
check(b'\x1b[?1006h' in buf, 'SGR mouse reporting enabled')
time.sleep(2); read_avail(1)

# ── first message: splash yields to the transcript ──
send(b'Reply with exactly WHEELOK and nothing else.\r')
ok = wait_for(b'WHEELOK', 180, 'first reply')
check(ok, 'chat round trip (splash gone after message)')

# fill the transcript so scrolling has room
send(b'/hotkeys\r')
time.sleep(1.2); read_avail(0.5)
for _ in range(4):
    send(b'\x1b[6~')   # PgDn back to bottom
    time.sleep(0.2); read_avail(0.2)

# ── mouse wheel: up scrolls (sticky 当前提示词 header appears) ──
send(b'\x1b[<64;10;20M')   # wheel up (SGR, press)
time.sleep(0.4); read_avail(0.3)
send(b'\x1b[<64;10;20M')
time.sleep(0.4); read_avail(0.3)
check('\u5f53\u524d\u63d0\u793a\u8bcd'.encode('utf-8') in buf, 'wheel up scrolls (sticky 当前提示词)')

# wheel down returns to follow
for _ in range(40):
    send(b'\x1b[<65;10;20M')
    time.sleep(0.05)
time.sleep(0.5); read_avail(0.4)

# ── wheel moves selection in an open overlay (/preset) ──
send(b'/preset\r')
time.sleep(1.0); read_avail(0.4)
check(b'\xe4\xbc\x9a\xe8\xaf\x9d\xe6\xa8\xa1\xe5\xbc\x8f' in buf, '/preset picker opens')
send(b'\x1b[<65;10;20M')   # wheel down in the picker
time.sleep(0.3); read_avail(0.3)
send(b'\x1b')              # close
time.sleep(0.4); read_avail(0.3)
check(b'\x1b\x1b' not in buf, 'no crash after wheel in overlay')

# wheel events must not corrupt subsequent typing
send(b'Reply with exactly WHEEL2 and nothing else.\r')
ok = wait_for(b'WHEEL2', 180, 'reply after wheels')
check(ok, 'chat round trip after wheel events')

# exit
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
