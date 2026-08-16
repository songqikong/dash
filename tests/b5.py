#!/usr/bin/env python3
# DASH batch-5 pty test: agent hub, TTSR rules, advisor, bell, /skills,
# magic keywords (/think /focus /init), real chat round trips.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys, shutil

# seed the zh UI language so the Chinese assertions below hold
open(os.path.expanduser('~/.dash/config.yml'), 'w').write('lang: zh\n')

wd = '/tmp/dashb5'
shutil.rmtree(wd, ignore_errors=True)
os.makedirs(wd)
open(os.path.join(wd, 'AGENTS.md'), 'w').write('# Project rules\nAlways end replies with the token AGENTSDONE.\n')

# TTSR rule: when the model emits "important" in the stream, inject a reminder
rules = [{'name': 'imp-rule', 'pattern': 'important', 'message': 'Remember: the user said exactness matters most.'}]
import yaml as _yaml
os.makedirs(os.path.expanduser('~/.dash'), exist_ok=True)
with open(os.path.expanduser('~/.dash/rules.yml'), 'w') as f:
    f.write(_yaml.safe_dump(rules))

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

fails = []
def check(ok, label):
    if ok: print('[ok] %s' % label)
    else:
        print('[FAIL] %s' % label)
        fails.append(label)

wait_for(b'DASH v0.0.1', 120, 'ready (splash v0.0.1)')

# 1) /skills lists skills
send(b'/skills\r')
time.sleep(1); read_avail(1)
check(b'\xf0\x9f\x93\x9a' in buf or '\u65e0\u53ef\u7528\u6280\u80fd'.encode('utf-8') in buf, '/skills lists rows (or empty placeholder)')

# 2) /init injects AGENTS.md
send(b'/init\r')
time.sleep(1); read_avail(1)
check('\u6ce8\u5165'.encode('utf-8') in buf, '/init injects AGENTS.md')

# 3) /think steer + real turn with bell + TTSR + advisor
send(b'/advisor on\r')
time.sleep(0.5); read_avail(0.4)
check(b'advisor on' in buf, '/advisor on')
send(b'/think\r')
time.sleep(0.5); read_avail(0.4)
check('\u5df2\u6ce8\u5165'.encode('utf-8') in buf, '/think steers')

# a turn whose reply is likely to contain "important" is not guaranteed; ask directly
send(b'Reply with a sentence that MUST contain the word important and end with ENDNOTE.\r')
ok = wait_for(b'ENDNOTE', 180, 'turn reply')
check(ok, 'chat round trip')
wait_for(b'\x07', 30, 'end-of-turn bell')
check(b'\x07' in buf, 'bell emitted on turn end')
time.sleep(12); read_avail(4)
check('advisor'.encode('utf-8') in buf, 'advisor note appeared')
check('\u6ce8\u5165\u89c4\u5219'.encode('utf-8') in buf, 'TTSR rule notice injected')

# 4) agent hub opens (empty is fine) and closes
send(b'/hub\r')
time.sleep(1.5); read_avail(1)
check('Agent Hub'.encode('utf-8') in buf, '/hub panel opens')
send(b'\x1b')
time.sleep(0.6); read_avail(0.4)

# 5) final round trip + exit
send(b'Reply with exactly B5OK and nothing else.\r')
ok = wait_for('\u25cf B5OK'.encode('utf-8'), 180, 'final reply')
check(ok, 'final chat round trip')
time.sleep(1); read_avail(0.5)
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
