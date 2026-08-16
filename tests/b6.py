#!/usr/bin/env python3
# DASH feature smoke test: agent presets (/preset, minimal switch on blank
# session, mount works, chat still fine) + omp-style settings panel
# (tabs, sections, type-to-search, cycle, changed markers).
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

wait_for(b'DASH v0.0.1', 120, 'ready')

# ── /preset picker shows the four official modes
send(b'/preset\r')
time.sleep(1.2); read_avail(0.5)
check(b'\xe4\xbc\x9a\xe8\xaf\x9d\xe6\xa8\xa1\xe5\xbc\x8f' in buf, '/preset picker opens')
check('极简'.encode('utf-8') in buf, 'minimal (极简模式) listed')
check('标准'.encode('utf-8') in buf, 'standard (标准模式) listed')
check(b'minimal' in buf, 'preset id shown')

# switch to minimal on a BLANK session -> immediate recreate + mount
send(b'\x1b[B\x1b[B\r')   # down to minimal (order: standard, code, minimal), enter
time.sleep(4); read_avail(2)
check(b'preset \xe2\x86\x92 minimal' in buf or b'preset -> minimal' in buf, 'preset switch status')

# chat round trip still works under the minimal preset (persona replaced)
send(b'Reply with exactly MODEOK and nothing else.\r')
ok = wait_for(b'MODEOK', 180, 'chat under minimal preset')
check(ok, 'chat round trip under minimal preset')
time.sleep(1); read_avail(0.5)

# ── /settings: omp-style panel
send(b'/settings\r')
time.sleep(1.5); read_avail(0.5)
check(b'settings' in buf, '/settings opens')
check(b'appearance' in buf and b'model' in buf and b'interaction' in buf and b'session' in buf, 'tab bar with 4 tabs')
check('主题'.encode('utf-8') in buf, 'appearance tab shows 主题 section')
# omp rows show the CURRENT value only (dark), not the option list
check(b'dark' in buf, 'theme item shows current value dark')

# type-to-search: 'advisor' finds the advisor setting across tabs
send(b'advisor')
time.sleep(0.5); read_avail(0.4)
check(b'advisor' in buf and b'match' in buf, 'type-to-search banner with match count')
# Enter cycles advisor off->on
send(b'\r')
time.sleep(0.5); read_avail(0.4)
check(b'on' in buf, 'search hit cycled to on')
# Esc exits search, Esc closes
send(b'\x1b')
time.sleep(0.3); read_avail(0.3)
send(b'\x1b')
time.sleep(0.4); read_avail(0.3)

# persisted config (flat-dot keys are written nested by setCfg)
cfg = open(os.path.expanduser('~/.dash/config.yml')).read()
check('id: minimal' in cfg, 'preset.id persisted')
check('enabled: true' in cfg, 'advisor.enabled persisted')

# ── /new uses the persisted minimal preset again
send(b'/new\r')
time.sleep(3); read_avail(1)
send(b'Reply with exactly MODEOK2 and nothing else.\r')
ok = wait_for(b'MODEOK2', 180, 'chat in new session under minimal')
check(ok, 'new session runs persisted minimal preset')

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
if fails:
    import re
    plain = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', buf.decode('utf-8', 'replace')).replace('\x1b', '^')
    with open('/tmp/b6_frame.txt', 'w') as f:
        f.write(plain)
sys.exit(1 if fails else 0)
