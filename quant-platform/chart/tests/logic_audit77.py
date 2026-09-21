"""A deploy the browser did not take.

REPORTED AS: "If I click 1 time it took me to the landing page if I press
again it took me to correct page."

The Screeners link had been fixed, pushed, pulled and restarted. Every server
was serving the new desk.js. The page in front of the reader was still running
the old one, so its first press used the old address; the second press was made
from the landing page, whose copy had just been fetched, and went where it
said. Two presses, two versions of one file, nothing in any log.

desk.js is not an asset in the sense the caching rules meant. It is the
NAVIGATION — every link from any program to any other is a string it computes —
and qp is the worst of the four servers for this, because Starlette's
StaticFiles sends an ETag and a Last-Modified and NO Cache-Control at all. With
no Cache-Control a browser is free to invent a freshness lifetime from the
file's age, and for a file last touched a week ago that invention is hours,
during which it never asks.

`no-cache` is not `no-store`: the file is kept and asked about, the answer is a
304 nearly every time, and the cost is one round trip on ten kilobytes.

THE MIDDLEWARE IS RUN, NOT READ. A substring search cannot tell a header that
is set from one that is set on the wrong path, or from one set on everything —
turning caching off for every chart, tile and script qp serves would be a much
worse change than the bug, and it looks identical in a grep.
"""
import asyncio
import pathlib
import re
import sys

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


def load():
    """The rule, lifted out of server.py and made callable.

    Importing chart.server would start a database, restore strategies and seed
    a bundle — minutes of work and a pile of side effects to check one header.
    The slice is anchored on both ends and a miss is said out loud rather than
    silently executing nothing, because an empty namespace would make every
    assertion below fail with AttributeError instead of naming what moved.
    """
    at = SRC.find('_SHARED_ASSETS = (')
    if at < 0:
        raise SystemExit('chart/server.py no longer names the shared assets — '
                         'desk.js carries the navigation of every page')
    end = SRC.find('\n    return response', at)
    if end < 0:
        raise SystemExit('chart/server.py has no _no_cache_shared to run')
    body = SRC[at:end + len('\n    return response')]

    class FakeApp:
        def middleware(self, kind):
            assert kind == 'http', kind
            return lambda fn: fn

    ns = {'app': FakeApp()}
    exec(compile(body, 'server.py-slice', 'exec'), ns)          # noqa: S102
    return ns


NS = load()


class Resp:
    def __init__(self):
        self.headers = {}


class Req:
    def __init__(self, path):
        self.url = type('U', (), {'path': path})()


def served(path):
    """The response headers qp would send for one path."""
    resp = Resp()

    async def call_next(_request):
        return resp

    return asyncio.run(NS['_no_cache_shared'](Req(path), call_next)).headers


print('\n── the two files that carry the navigation ───────────────────────')

ok('the shared list is the two of them, under the prefix qp mounts',
   NS['_SHARED_ASSETS'] == ('/static/desk.js', '/static/desk.css'),
   repr(NS.get('_SHARED_ASSETS')))

for p in ('/static/desk.js', '/static/desk.css'):
    ok(f'{p} is revalidated before it is used',
       'no-cache' in served(p).get('Cache-Control', ''),
       repr(served(p)))


print('\n── and nothing else is touched ───────────────────────────────────')

# The rule being narrow is the whole reason it is safe. qp serves the charting
# library, the page shell and every tile from the same mount; putting those on
# no-cache would add a round trip to each one on every load, on a phone, to fix
# a problem none of them have.
for p in ('/static/lightweight-charts.js', '/static/index.html', '/static/',
          '/api/health', '/desk.js', '/static/desk.js.map'):
    ok(f'{p} keeps normal caching',
       'Cache-Control' not in served(p),
       repr(served(p)))


print('\n── the response is the one the app built ─────────────────────────')

# A middleware that returned something of its own would answer every request
# with an empty 200 — every chart on the platform blank, and this test green.
_mine = Resp()


async def _passthrough(_request):
    return _mine


ok('the downstream response is passed through, not replaced',
   asyncio.run(NS['_no_cache_shared'](Req('/static/desk.js'), _passthrough)) is _mine)


print('\n── it is mounted where it can see the static files ───────────────')

# A middleware declared before app.mount still runs for the mounted routes —
# Starlette wraps the whole application — but the MOUNT has to exist, and the
# paths above have to be the ones it is mounted at. A prefix change with no
# change here is a rule that matches nothing and says nothing.
mount = re.search(r"app\.mount\('(/[a-z]+)', StaticFiles", SRC)
ok('the static mount is found', mount is not None)
if mount:
    ok('and every shared path sits under it',
       all(p.startswith(mount.group(1) + '/') for p in NS['_SHARED_ASSETS']),
       f'mounted at {mount.group(1)}')

# The file it is protecting has to be there to be protected.
for name in ('desk.js', 'desk.css'):
    ok(f'chart/static/{name} exists to be served',
       (ROOT / 'chart' / 'static' / name).is_file())


print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
