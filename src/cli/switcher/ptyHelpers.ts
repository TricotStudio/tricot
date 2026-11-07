// The small programs that give each agent a pseudo-terminal of its own
// (pty.ts runs them): Node can't make one, and a native add-on is the one
// thing Tricot's single-file install can't carry. They are kept here as
// strings, run with `perl -e` and `python3 -c`, so nothing is written to disk.
//
// Both speak the same protocol with Tricot:
//   perl -e PERL_HELPER -- ROWS COLS command [args...]
//   fd 0  the agent's keys (written to the pty)
//   fd 1  everything the agent draws (read from the pty)
//   fd 3  control, a line each:
//         from Tricot:  "R rows cols"  resize (the kernel sends the agent SIGWINCH)
//                       "K SIGNAME"    signal the agent's process group
//         to Tricot:    "P pid tty"    started
//                       "E code sig"   the agent ended, after its last output
//
// The agent leads a session of its own on its pty, so the terminal Tricot
// runs in never sends it a signal. When Tricot goes away, even killed
// outright, fd 0 and fd 3 close: the helper hangs the agent up (SIGHUP to
// its process group, as when a terminal window closes) and kills it two
// seconds later if it is still there. A SIGHUP or SIGTERM to the helper does
// the same. An agent that stops itself (Ctrl+Z's SIGTSTP never reaches it,
// as its process group has no parent in its session, but a SIGSTOP would) is
// continued at once: nothing outside could bring it back.
//
// The Perl one uses IO::Pty, which macOS ships with its Perl
// (/System/Library/Perl/Extras), so it needs no Command Line Tools. The
// Python one uses the standard library, for Linux, where IO::Pty is often
// missing and python3 is usually there.

// Perl's ${^CHILD_ERROR_NATIVE}, which a template literal can't hold as it is.
const NATIVE_STATUS = '${^CHILD_ERROR_NATIVE}';

export const PERL_HELPER = String.raw`
use strict;
use warnings;
use IO::Pty;
use IO::Select;
use POSIX qw(:sys_wait_h);
use Fcntl;
use Time::HiRes qw(time);

my ($rows, $cols, @cmd) = @ARGV;
die "usage: ROWS COLS command...\n" unless @cmd;
$SIG{$_} = 'IGNORE' for qw(PIPE INT QUIT TSTP TTIN TTOU);

my $pty = IO::Pty->new or die "Couldn't open a pseudo-terminal: $!\n";
sub winsize {
    my ($fh, $r, $c) = @_;
    if ($fh->can('set_winsize')) { $fh->set_winsize($r, $c, 0, 0) }
    else { ioctl($fh, &IO::Tty::Constant::TIOCSWINSZ, pack('S4', $r, $c, 0, 0)) }
}
winsize($pty->slave, $rows, $cols);
my $tty = $pty->ttyname // '';
open(my $ctl, '+<&=', 3) or die "fd 3: $!\n";
$ctl->autoflush(1);

my $pid = fork();
die "fork: $!\n" unless defined $pid;
if ($pid == 0) {
    close $ctl;
    $SIG{$_} = 'DEFAULT' for qw(PIPE INT QUIT TSTP TTIN TTOU HUP TERM CHLD);
    $pty->make_slave_controlling_terminal();
    my $s = $pty->slave;
    close $pty;
    open(STDIN, '<&', $s) or POSIX::_exit(126);
    open(STDOUT, '>&', $s) or POSIX::_exit(126);
    open(STDERR, '>&', $s) or POSIX::_exit(126);
    close $s;
    POSIX::close($_) for 3 .. 255;
    no warnings 'exec';
    exec { $cmd[0] } @cmd or do { print STDERR "Couldn't start $cmd[0]: $!\n"; POSIX::_exit(127) };
}
# The slave stays open here: macOS drops what the agent wrote that was not yet
# read once the last slave closes, so a fast agent's last words would be lost.
print $ctl "P $pid $tty\n";
for my $fh ($pty, \*STDIN, \*STDOUT, $ctl) { my $f = fcntl($fh, F_GETFL, 0); fcntl($fh, F_SETFL, $f | O_NONBLOCK); }
binmode $_ for ($pty, \*STDIN, \*STDOUT);

my ($toApp, $toHost, $ctlbuf) = ('', '', '');
my ($status, $hupAt) = (undef, 0);
my $readers = IO::Select->new($pty, \*STDIN, $ctl);
sub hang_up { $hupAt ||= time; kill 'HUP', -$pid; kill 'HUP', $pid; }
$SIG{HUP} = $SIG{TERM} = sub { hang_up() };
sub gone { my ($n) = @_; return !defined $n ? !$!{EAGAIN} && !$!{EINTR} : $n == 0; }

while (1) {
    my $writers = IO::Select->new();
    $writers->add($pty) if length $toApp && $readers->exists($pty);
    $writers->add(\*STDOUT) if length $toHost;
    my ($r, $w) = IO::Select->select($readers, $writers, undef, 0.2);
    for my $fh (@{ $r || [] }) {
        my $buf = '';
        my $n = sysread($fh, $buf, 65536);
        if ($fh == $pty) {
            if ($n) { $toHost .= $buf } elsif (gone($n)) { $readers->remove($pty) }
        } elsif ($fh == $ctl) {
            if ($n) {
                $ctlbuf .= $buf;
                while ($ctlbuf =~ s/^([^\n]*)\n//) {
                    my @m = split ' ', $1;
                    next unless @m;
                    if ($m[0] eq 'R' && @m == 3) { winsize($pty, $m[1], $m[2]) }
                    elsif ($m[0] eq 'K' && @m == 2) { kill $m[1], -$pid; kill $m[1], $pid }
                }
            } elsif (gone($n)) { $readers->remove($ctl); hang_up() }
        } else {
            if ($n) { $toApp .= $buf } elsif (gone($n)) { $readers->remove(\*STDIN); hang_up() }
        }
    }
    for my $fh (@{ $w || [] }) {
        if ($fh == $pty) {
            my $n = syswrite($pty, $toApp);
            if ($n) { substr($toApp, 0, $n) = '' } elsif (gone($n)) { $toApp = '' }
        } else {
            my $n = syswrite(STDOUT, $toHost);
            if ($n) { substr($toHost, 0, $n) = '' } elsif (gone($n)) { $toHost = ''; hang_up() }
        }
    }
    if (!defined $status) {
        my $k = waitpid($pid, WNOHANG | WUNTRACED);
        if ($k == $pid) {
            # Perl makes $? up from how the agent exited or was killed, so it
            # reads 0 for one that stopped: only the native status says so.
            if (WIFSTOPPED(${NATIVE_STATUS})) { kill 'CONT', -$pid; kill 'CONT', $pid }
            else { $status = $? }
        }
    }
    if (defined $status) {
        # What the agent wrote before it ended is in the pty already; take
        # it, without waiting on anything it left running there.
        for (1 .. 64) {
            last unless $readers->exists($pty);
            my $buf = '';
            my $n = sysread($pty, $buf, 65536);
            if ($n) { $toHost .= $buf } else { $readers->remove($pty) }
        }
        last unless length $toHost;
    }
    if ($hupAt && !defined $status && time - $hupAt >= 2) { kill 'KILL', -$pid; kill 'KILL', $pid }
}
my ($code, $sig) = (($status >> 8) & 255, $status & 127);
print $ctl "E $code $sig\n";
exit 0;
`;

export const PYTHON_HELPER = String.raw`
import errno, fcntl, os, select, signal, struct, sys, termios, time

rows, cols, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
for s in (signal.SIGPIPE, signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU):
    signal.signal(s, signal.SIG_IGN)
master, slave = os.openpty()
def winsize(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
winsize(slave, rows, cols)
tty = os.ttyname(slave)
ctl = 3

pid = os.fork()
if pid == 0:
    for s in (signal.SIGPIPE, signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU, signal.SIGHUP, signal.SIGTERM, signal.SIGCHLD):
        signal.signal(s, signal.SIG_DFL)
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    os.closerange(3, 256)
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        os.write(2, ("Couldn't start %s: %s\n" % (cmd[0], e.strerror)).encode())
        os._exit(127)
# The slave stays open here: macOS drops what the agent wrote that was not yet
# read once the last slave closes, so a fast agent's last words would be lost.
os.write(ctl, ('P %d %s\n' % (pid, tty)).encode())
for fd in (master, 0, 1, ctl):
    fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)

to_app, to_host, ctlbuf = bytearray(), bytearray(), b''
readers = {master, 0, ctl}
status, hup_at = None, 0.0

def signal_app(sig):
    for target in (-pid, pid):
        try:
            os.kill(target, sig)
        except OSError:
            pass

def hang_up(*_):
    global hup_at
    hup_at = hup_at or time.time()
    signal_app(signal.SIGHUP)

signal.signal(signal.SIGHUP, hang_up)
signal.signal(signal.SIGTERM, hang_up)

def read(fd):
    try:
        return os.read(fd, 65536)
    except (BlockingIOError, InterruptedError):
        return None
    except OSError:
        return b''

while True:
    writers = ([master] if to_app and master in readers else []) + ([1] if to_host else [])
    try:
        r, w, _ = select.select(list(readers), writers, [], 0.2)
    except InterruptedError:
        r, w = [], []
    for fd in r:
        data = read(fd)
        if data is None:
            continue
        if fd == master:
            if data: to_host += data
            else: readers.discard(master)
        elif fd == ctl:
            if not data:
                readers.discard(ctl); hang_up(); continue
            ctlbuf += data
            while b'\n' in ctlbuf:
                line, ctlbuf = ctlbuf.split(b'\n', 1)
                m = line.decode('ascii', 'replace').split()
                if len(m) == 3 and m[0] == 'R':
                    winsize(master, int(m[1]), int(m[2]))
                elif len(m) == 2 and m[0] == 'K':
                    name = m[1] if m[1].startswith('SIG') else 'SIG' + m[1]
                    if hasattr(signal, name):
                        signal_app(getattr(signal, name))
        else:
            if data: to_app += data
            else:
                readers.discard(0); hang_up()
    for fd in w:
        buf = to_app if fd == master else to_host
        try:
            n = os.write(fd, buf)
            del buf[:n]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            del buf[:]
            if fd == 1: hang_up()
    if status is None:
        try:
            k, st = os.waitpid(pid, os.WNOHANG | os.WUNTRACED)
        except ChildProcessError:
            k, st = pid, 0
        if k == pid:
            if os.WIFSTOPPED(st): signal_app(signal.SIGCONT)
            else: status = st
    if status is not None:
        for _ in range(64):
            if master not in readers: break
            data = read(master)
            if data: to_host += data
            else: readers.discard(master)
        if not to_host:
            break
    if hup_at and status is None and time.time() - hup_at >= 2:
        signal_app(signal.SIGKILL)

code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 0
sig = os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0
try:
    os.write(ctl, ('E %d %d\n' % (code, sig)).encode())
except OSError:
    pass
`;

// The last resort, macOS's (BSD) or Linux's (util-linux) `script`: it gives
// a command a pty, but starts it at 0x0, can't be told its size, and only
// notices the command ended on its next keystroke. So a small shell script
// inside it sets the size, says where the pty is, and reports the exit on
// fd 3; `cat` feeds it, as script can't read from Node's socket. Its trap
// keeps it there to say so when a signal to the process group ends the
// agent (a trap, unlike ignoring, leaves the agent's own signals as they
// were). script itself outlives Tricot, so a watchdog hangs the agent up,
// then kills it, once Tricot's process is gone.
export function scriptWrapper(rows: number, cols: number, host: number): string {
  const watchdog = `( trap : HUP; while kill -0 ${host} 2>/dev/null; do sleep 1; done; kill -HUP -$$ 2>/dev/null; sleep 2; kill -KILL -$$ 2>/dev/null ) </dev/null >/dev/null 2>&1 3>&- &`;
  return `trap : HUP INT TERM; stty rows ${rows} cols ${cols} 2>/dev/null; echo "P $$ $(tty)" >&3; ${watchdog} w=$!; "$@" 3>&-; s=$?; kill $w 2>/dev/null; echo "E $s 0" >&3`;
}
