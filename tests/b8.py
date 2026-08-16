#!/usr/bin/env python3
# DASH batch-8 pty test: default UI is fully English; /lang + settings switch
# to zh and back; omp-style status line (no context bar), input at the bottom.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys

# fresh config: NO lang key -> default en
for p in (os.path.expanduser('~/.dash/config.yml'), os.path.expanduser('~/.dash/keybindings.yml')):
    if os.path.exists(p):
        os.remove(p)

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

ok = wait_for(b'Welcome back!', 60, 'splash')
check(ok, 'welcome splash (en default)')

# ── settings panel is fully English by default ──
send(b'/settings\r')
time.sleep(1.5); read_avail(0.5)
check(b'Theme' in buf and b'Display' in buf, 'settings groups in English (Theme/Display)')
check('\u4e3b\u9898'.encode('utf-8') not in buf, 'no Chinese section names (主题 absent)')
check(b'Language' in buf, 'Language setting present')
check(b'en' in buf, 'language value en')
# switch language via the settings panel: search 'lang', cycle to zh
send(b'lang')
time.sleep(0.5); read_avail(0.4)
send(b'\x1b[B')   # down to the Language item (search matches several rows)
time.sleep(0.3); read_avail(0.3)
send(b'\r')   # cycle en -> zh (search view stays open; the item label flips to 语言)
time.sleep(0.5); read_avail(0.4)
check('\u8bed\u8a00'.encode('utf-8') in buf, 'lang item label switches to 语言')
send(b'\x1b')   # exit search
read_avail(0.1)
send(b'\x1b')   # close panel (separate Esc events, >50ms apart)
time.sleep(0.4); read_avail(0.3)

# ── omp-style status line: no context bar, model glyph + tokens + elapsed ──
check(b'\xe2\xac\xa2' in buf, '⬢ model glyph in status line')
check(b'ctx ' not in buf and '\u258f'.encode('utf-8') not in buf, 'context bar removed (no ▏/ctx)')
check(b'/help' in buf, 'status line hint present')

# ── /lang command switches back to en ──
send(b'/lang en\r')
time.sleep(0.5); read_avail(0.4)
check(b'lang \xe2\x86\x92 en' in buf, '/lang en status')
cfg = open(os.path.expanduser('~/.dash/config.yml')).read()
check('lang: en' in cfg, 'config persists lang en after /lang en')

# ── chat works; sticky prompt is English in en mode ──
send(b'Reply with exactly LANGOK and nothing else.\r')
ok = wait_for(b'LANGOK', 180, 'reply')
check(ok, 'chat round trip')
send(b'/hotkeys\r')
time.sleep(1.2); read_avail(0.5)
send(b'\x1b[<64;10;20M')   # wheel up
time.sleep(0.4); read_avail(0.3)
send(b'\x1b[<64;10;20M')
time.sleep(0.4); read_avail(0.3)
check(b'current prompt' in buf, 'sticky header in English (current prompt)')

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
