"""Fourteen thousand banners for a server that never started.

pm2 reported qp `online`, restarts 14502, uptime 1 second. The log, once a
second since the day it was put under a process manager:

    [env] loaded 1 value(s) from .env
    qp charting platform on http://0.0.0.0:8765 — build de8139b — 71 primitives

and then nothing, because the process was already gone. Port 8765 was held by
another copy of this same server — the one started by hand, before pm2 — so
uvicorn could not bind and exited, and pm2 started it again, and it printed
the banner again.

THE BANNER WAS PRINTED BEFORE THE BIND. That is the whole bug. It is the same
shape as two others found on this desk the same night: a line that says the
same thing whether or not the thing happened is worth exactly as much as no
line, and this one was on the process every live decision goes through.

Nobody could have read it differently. There is no wording of "qp charting
platform on http://0.0.0.0:8765" that means "and then it died". The order had
to change.

These check the order and the failure, by RUNNING main() — a substring search
cannot tell a print that happens before a bind from one that happens after.
"""
import errno
import io
import pathlib
import socket
import sys
import types
import contextlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}' + (f'   [{extra}]' if extra else ''))


SRC = (ROOT / 'chart' / 'server.py').read_text()


def main_fn():
    """chart.server.main, lifted out so importing the whole server is not needed.

    Importing chart.server opens a database, restores strategies and seeds a
    bundle — minutes of work and a pile of side effects to check the order of
    two statements. The slice is anchored at both ends and a miss is said out
    loud, because an empty namespace would fail every check below with an
    AttributeError instead of naming what moved.
    """
    at = SRC.find('def main():')
    if at < 0:
        raise SystemExit('chart/server.py has no main() — that is what pm2 runs')
    end = SRC.find("\nif __name__ == '__main__':", at)
    if end < 0:
        raise SystemExit('chart/server.py has no entry point to run main() from')
    ns = {'cs': type('cs', (), {'_BUILD': 'testbuild', 'REGISTRY': {}})(),
          'app': object()}
    exec(compile(SRC[at:end], 'server.py-main', 'exec'), ns)          # noqa: S102
    return ns['main']


MAIN = main_fn()


def run(port, host='127.0.0.1'):
    """main() with those args, returning (exit code or None, everything printed)."""
    out = io.StringIO()
    argv = sys.argv
    sys.argv = ['chart.server', '--host', host, '--port', str(port)]
    code = None
    try:
        with contextlib.redirect_stdout(out):
            MAIN()
    except SystemExit as e:
        code = e.code
    except Exception as e:                                            # noqa: BLE001
        code = f'{type(e).__name__}: {e}'
    finally:
        sys.argv = argv
    return code, out.getvalue()


print('\n── a port that is already taken ──────────────────────────────────')

held = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
held.bind(('127.0.0.1', 0))
held.listen(1)
BUSY = held.getsockname()[1]

code, said = run(BUSY)

ok('it does not start', code == 3, f'exit {code!r}')
# THE POINT. Fourteen thousand of these were printed for a server that never
# served, and the count is the only reason anybody looked.
ok('and it does NOT print the banner', 'qp charting platform' not in said,
   said.strip()[:120])
ok('it says it did not start', 'qp DID NOT START' in said, said.strip()[:120])
ok('it names the port', str(BUSY) in said)
ok('and it names the likely cause', 'already in use' in said)
# The next command a person runs, in the message that told them they need one.
ok('and how to find what is holding it', 'ss -ltnp' in said, said.strip()[:200])


print('\n── a port that is free ───────────────────────────────────────────')


class _Ran(Exception):
    """uvicorn.run reached — the only way to prove the banner came first."""


def _fake_uvicorn_run(*_a, **_k):
    raise _Ran()


# A stand-in module, so this runs on a box with no uvicorn installed AND so
# reaching `run` is observable. It is put in sys.modules rather than patched
# into a namespace because main() imports it by name, at call time.
_stub = types.ModuleType('uvicorn')
_stub.run = _fake_uvicorn_run
_had = sys.modules.get('uvicorn')
sys.modules['uvicorn'] = _stub

free = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
free.bind(('127.0.0.1', 0))
FREE = free.getsockname()[1]
free.close()

code, said = run(FREE)

if _had is None:
    del sys.modules['uvicorn']
else:
    sys.modules['uvicorn'] = _had

ok('it reaches uvicorn.run', code is not None and '_Ran' in str(code),
   f'{code!r} / {said.strip()[:120]}')
ok('and the banner IS printed then', 'qp charting platform' in said,
   said.strip()[:120])
ok('with the port it bound', f':{FREE}' in said)
ok('and nothing claims a failure', 'DID NOT START' not in said)

held.close()


print('\n── the order is the fix, so the order is what is pinned ──────────')

src_main = SRC[SRC.find('def main():'):]
probe_at = src_main.find('probe.bind(')
banner_at = src_main.find("print(f'qp charting platform")
serve_at = src_main.find('uvicorn.run(')
ok('the bind check exists', probe_at > 0)
ok('the banner comes AFTER it', 0 < probe_at < banner_at, f'{probe_at} vs {banner_at}')
ok('and uvicorn after that', banner_at < serve_at, f'{banner_at} vs {serve_at}')
# A probe left open is a port this process is holding against itself.
ok('the probe socket is always closed', 'finally:' in src_main
   and 'probe.close()' in src_main)
# SO_REUSEADDR would answer a different question — see the docstring. Checked
# by the CALL, not the word: the docstring explains why it is absent, and a
# grep for the word finds the explanation.
ok('and the probe does not set a socket option',
   'probe.setsockopt' not in src_main)
# uvicorn is not loaded for a start that cannot succeed.
ok('uvicorn is imported after the check, not before',
   src_main.find('import uvicorn') > probe_at,
   f'{src_main.find("import uvicorn")} vs {probe_at}')


print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
