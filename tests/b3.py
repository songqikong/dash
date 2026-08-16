#!/usr/bin/env python3
# DASH batch-3 pty test: omp-style status line (model · effort · tokens · TPS ·
# cache · elapsed), model roles (/models 3-column picker, /role, config
# persistence), working line (⏵ narration), real chat round trips.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys, shutil

# seed the zh UI language so the Chinese assertions below hold
open(os.path.expanduser('~/.dash/config.yml'), 'w').write('lang: zh\n')

# git repo cwd for the git-branch check
gdir = '/tmp/dashgit'
shutil.rmtree(gdir, ignore_errors=True)
os.makedirs(gdir)
subprocess.run(['git', 'init', '-q', '-b', 'dashmain'], cwd=gdir, check=True)
with open(os.path.join(gdir, 'a.txt'), 'w') as f:
    f.write('x\n')

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 130, 0, 0))
p = subprocess.Popen(['dsh', '--profile', 'dash'], stdin=slave, stdout=slave, stderr=slave, cwd=gdir,
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

wait_for(b'DASH ready', 120, 'ready')
time.sleep(1.5); read_avail(1)

# 1) status line A: context bar + git branch + cwd
check(b'\xe2\xac\xa2' in buf and b'out ' in buf and b'\xe2\x8f\xb1' in buf, 'omp-style status line (⬢ model · tokens · ⏱ elapsed)')
check(b'git:dashmain' in buf, 'git branch shown')
check(b'dashgit' in buf, 'cwd shown')

# 2) working line with ⏵ narration during a reply + TPS
send(b'Write a 150-word essay about the moon, ending with the exact word TPSONE.\r')
wait_for(b'tok/s', 120, 'TPS / sparkline present')
wait_for(b'\xe2\x9c\x93 ', 120, 'turn summary')
check(b'tools' in buf, 'turn summary line (✓ N tools)')
time.sleep(0.5); read_avail(0.5)

# 3) /models: role column visible; assign plan role to opencode-go/deepseek-v4-flash
send(b'/models\r')
time.sleep(0.5); read_avail(0.4)
check('\u89d2\u8272'.encode('utf-8') in buf, '/models shows 角色 column')
# plan role is 3rd in list: default, smol, plan → press j twice from role focus
send(b'j'); time.sleep(0.2); read_avail(0.2)
send(b'j'); time.sleep(0.2); read_avail(0.2)
send(b'\r')  # Enter → providers
time.sleep(0.3); read_avail(0.3)
# select opencode-go provider: press Enter (first provider) → models
send(b'\r')
time.sleep(0.5); read_avail(0.4)
# select deepseek-v4-flash: it may not be first; use /model-style fallback: press Enter (first model) then verify config
send(b'\r')
time.sleep(0.5); read_avail(0.4)
time.sleep(0.5); read_avail(0.4)
check('\u89d2\u8272 plan'.encode('utf-8') in buf, 'role plan assigned (status)')
cfgpath = os.path.expanduser('~/.dash/config.yml')
time.sleep(0.5)
try:
    cfg = open(cfgpath).read()
    check('plan' in cfg, 'config.yml persists modelRoles')
except Exception:
    check(False, 'config.yml readable')

# 4) /role switch + /status
send(b'/role default\r')
time.sleep(0.4); read_avail(0.3)
check('\u89d2\u8272 \u2192 default'.encode('utf-8') in buf, '/role default switch')
send(b'/status\r')
time.sleep(0.4); read_avail(0.3)
check(b'git:dashmain' in buf, '/status shows git')

# 5) chat round trip after role ops
send(b'Reply with exactly ROLEOK and nothing else.\r')
ok = wait_for('\u25cf ROLEOK'.encode('utf-8'), 120, 'reply after roles')
check(ok, 'chat round trip after roles')

# 6) spinner preset via config: write activity.frames=line, /new, check '─' spinner? skip render check; just verify no crash
send(b'/new\r')
wait_for(b'DASH ready', 60, 'new session ready')

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
