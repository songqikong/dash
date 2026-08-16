#!/usr/bin/env python3
# DASH batch-1 pty test: editor, dialogs, commands, external editor,
# real chat round trip, exit.
import os, pty, select, time, subprocess, fcntl, termios, struct, sys

# deterministic start: default (en) UI, no leftover config
for p in (os.path.expanduser('~/.dash/config.yml'), os.path.expanduser('~/.dash/keybindings.yml')):
    if os.path.exists(p):
        os.remove(p)

with open('/tmp/dash_ed.sh', 'w') as f:
    f.write('#!/bin/sh\nprintf edited > "$1"\n')
os.chmod('/tmp/dash_ed.sh', 0o755)

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
env = {**os.environ, 'TERM': 'xterm-256color', 'NODE_ENV': 'production', 'EDITOR': '/tmp/dash_ed.sh'}
p = subprocess.Popen(['dsh', '--profile', 'dash'], stdin=slave, stdout=slave, stderr=slave,
                     env=env, close_fds=True)
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

# editor: type + multiline (kitty shift+enter, ctrl+j)
send(b'draft-ok')
time.sleep(0.3); read_avail(0.3)
check(b'draft-ok' in buf, 'editor typing')
send(b'\x1b[13;2u')  # shift+enter
time.sleep(0.3); read_avail(0.3)
send(b'line2')
time.sleep(0.3); read_avail(0.3)
send(b'\x0a')        # ctrl+j newline
time.sleep(0.3); read_avail(0.3)
send(b'line3')
time.sleep(0.3); read_avail(0.3)
check(b'line2' in buf and b'line3' in buf, 'multiline (shift+enter + ctrl+j)')

# word ops: ctrl+w should delete the last word 'line3' -> check 'line2' remains
send(b'\x17')        # ctrl+w
time.sleep(0.3); read_avail(0.3)
# ctrl+k delete to line end, ctrl+y yank back
send(b'\x0b')        # ctrl+k
time.sleep(0.3); read_avail(0.3)
send(b'\x19')        # ctrl+y
time.sleep(0.3); read_avail(0.3)

# external editor (EDITOR writes 'edited')
send(b'\x15')        # ctrl+u clear draft
send(b'xyz')
time.sleep(0.2); read_avail(0.2)
send(b'\x07')        # ctrl+g
time.sleep(2); read_avail(1)
check(b'edited' in buf, 'ctrl+g external editor round trip')

# clear, /help, esc close
send(b'\x15')
send(b'/help\r')
time.sleep(0.3); read_avail(0.3)
check(b'oh-my-pi TUI usage' in buf, '/help overlay')
send(b'\x1b')
time.sleep(0.5); read_avail(0.3)

# /hotkeys (rendered into the scrollable transcript; scroll to top to see head)
send(b'/hotkeys\r')
time.sleep(0.3); read_avail(0.3)
for _ in range(4):
    send(b'\x1b[5~')   # PgUp
    time.sleep(0.2); read_avail(0.2)
check(b'app.model.cycleForward' in buf, '/hotkeys lists bindings (scrollable)')
for _ in range(6):
    send(b'\x1b[6~')   # PgDn back to bottom (follow)
    time.sleep(0.2); read_avail(0.2)

# command menu
send(b'\x15')
send(b'/')
time.sleep(0.3); read_avail(0.3)
check(b'commands:' in buf, '/ command menu opens')
send(b'ne')
time.sleep(0.3); read_avail(0.3)
send(b'\t')          # tab completes
time.sleep(0.3); read_avail(0.3)
send(b'\x1b')
time.sleep(0.4); read_avail(0.3)
send(b'\x15')        # clear the completed /new draft

# history search restore
send(b'hi there\r')
wait_for(b'\xe2\x97\x8f idle', 120, 'idle after first turn')
send(b'\x12')        # ctrl+r
time.sleep(0.3); read_avail(0.3)
check(b'history search' in buf, 'ctrl+r history search opens')
send(b'\r')
time.sleep(0.3); read_avail(0.3)
check(b'hi there' in buf, 'history restored to editor')
send(b'\x15')

# real chat round trip
send(b'Reply with exactly the word DASHY and nothing else.\r')
ok = wait_for('\u25cf DASHY'.encode('utf-8'), 180, 'assistant DASHY reply')
check(ok, 'chat round trip')
time.sleep(1); read_avail(0.5)

# exit via ctrl+d confirm
send(b'\x04')
time.sleep(0.3); read_avail(0.3)
check(b'exit DASH? [y/n]' in buf, 'ctrl+d exit confirm')
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
