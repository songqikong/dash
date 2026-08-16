#!/usr/bin/env python3
# DASH batch-2 pty test: markdown rendering, message metadata, sticky prompt
# header, double-Esc rewind with fork replay, session title, chat round trips.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys

# seed the zh UI language so the Chinese assertions below hold
open(os.path.expanduser('~/.dash/config.yml'), 'w').write('lang: zh\n')

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
p = subprocess.Popen(['dsh', '--profile', 'dash'], stdin=slave, stdout=slave, stderr=slave,
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

# 1) markdown-rich reply
send(b'Reply in markdown. Include a level-2 heading with the exact text DASHH2, '
     b'a code block containing exactly DASHCODE42, and a table with columns '
     b'COLX and COLY and one row with values DASHA and DASHB. Nothing else.\r')
ok = wait_for(b'DASHCODE42', 180, 'code block text')
check(ok, 'markdown reply (heading + code)')
time.sleep(2); read_avail(1)
check(b'DASHA' in buf and b'DASHB' in buf, 'table cells visible')
check(b'\x1b[48;5;236' in buf, 'code block bg style present')
check(b'\x1b[38;5;121;1m' in buf or b'\x1b[38;5;78;1m' in buf, 'heading style present')
# metadata line (· HH:MM:SS · Ns · model)
check(b'\xc2\xb7 ' in buf, 'message metadata line present')
# session title in topbar (dim ' · ' near the model)
wait_for(b'\xe2\x97\x8f idle', 30, 'idle after md turn')

send(b'What is the capital of the moon?\r')
wait_for('\u25cf '.encode('utf-8'), 120, '2nd reply streaming started')
time.sleep(6); read_avail(2)

# 3) double-Esc rewind: dialog opens, select latest user msg, replay + draft
send(b'\x1b'); time.sleep(0.15); send(b'\x1b')   # two Esc quickly
time.sleep(0.5); read_avail(0.3)
check('\u65f6\u95f4\u56de\u6eaf'.encode('utf-8') in buf, 'rewind dialog opens (double Esc)')
send(b'\r')          # select newest user message (moon question)
time.sleep(3); read_avail(1)
check('\u5df2\u56de\u6eda\u5230'.encode('utf-8') in buf, 'rewind executed (已回滚到)')
check(b'capital of the moon' in buf, 'replayed transcript visible')
# draft prefilled with the rewound message; clear and send a fresh deterministic one
send(b'\x15')
send(b'Reply with exactly the word REWOK and nothing else.\r')
ok = wait_for('\u25cf REWOK'.encode('utf-8'), 180, 'reply after rewind')
check(ok, 'chat round trip after rewind')

# 4) follow-up queue still fine + exit
send(b'Reply with exactly the word FINALOK.\r')
ok = wait_for('\u25cf FINALOK'.encode('utf-8'), 180, 'final reply')
check(ok, 'chat round trip (final)')
time.sleep(1); read_avail(0.5)

# 5) grow the transcript, then sticky prompt header
for i in range(4):
    send(('Reply with exactly WORDG%d and nothing else.\r' % i).encode())
    wait_for(('\u25cf WORDG%d' % i).encode('utf-8'), 120, 'grow turn %d' % i)
time.sleep(1.5); read_avail(1)
for _ in range(5):
    send(b'\x1b[5~')  # PgUp x5
    time.sleep(0.2); read_avail(0.2)
check('\u5f53\u524d\u63d0\u793a\u8bcd'.encode('utf-8') in buf, 'sticky 当前提示词 header')
for _ in range(6):
    send(b'\x1b[6~'); time.sleep(0.15); read_avail(0.15)

send(b'\x04')        # ctrl+d
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
