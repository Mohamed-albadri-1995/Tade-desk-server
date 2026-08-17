"""Strategies survive a deploy — where they are stored, and who may overwrite them.

The reported symptom was flat: "I build strategies in the tool and every time I
deploy something I lose them." Three separate things could produce it, and this
part pins all three.

PART A — THE FILE IS NOT IN THE REPOSITORY.
  platform.db used to live at chart/platform.db: inside the working tree of the
  same checkout the deploy script hard-resets. Gitignoring it stops `git reset
  --hard`, and nothing else — one `git clean -fdx`, one re-clone, one fresh
  checkout, and every strategy is gone. It now lives under ~/.qp, which no git
  command can reach, and an existing in-repo file is carried across on first
  boot rather than abandoned.

PART B — A HUMAN'S SAVE OUTRANKS THE BUNDLE.
  Seeds re-sync on every startup so engine fixes reach our canonical scalps.
  Seven of them carry no `_keep_user_edits`, so editing one in the builder was
  silently reverted by the next restart — which, from the browser, is exactly
  "my strategy disappeared after a deploy". A row saved by a human is now
  protected whatever the bundle says.

PART C — A SECOND COPY, IN PLAIN TEXT.
  One JSON file per strategy next to the DB. If the database is ever empty —
  wiped, or a brand-new box — they are read back at startup. Never merged into
  a database that still has rows: this restores a loss, it does not resurrect a
  deliberate delete.
"""
import importlib
import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0
FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {extra}")


_tmp = tempfile.TemporaryDirectory()
_root = pathlib.Path(_tmp.name)

import chart.store as store                                  # noqa: E402


def fresh(db_name='platform.db', backup=None):
    """A store pointed at an empty temp directory, with its connection reset.

    `_LEGACY_DB` is pointed at nothing: otherwise opening a brand-new temp
    database triggers the real migration and copies the developer's actual
    strategies in, which is correct behaviour and useless in a fixture.
    """
    store._LEGACY_DB = _root / 'no-legacy.db'
    store._DB = _root / db_name
    store._conn = None
    os.environ['QP_STRATEGY_BACKUP'] = str(backup or (_root / 'strategies'))
    return store


# ── PART A · where the file lives ───────────────────────────────────────────
print("PART A — the database is outside the repository")

_saved_db = store._DB
_default = store._default_db()
_repo_chart = pathlib.Path(store.__file__).resolve().parent

ok("the default path is not inside the chart package",
   _repo_chart not in _default.parents and _default.parent != _repo_chart,
   f"got {_default}")
ok("it is under the home directory, where no deploy reaches",
   str(_default).startswith(str(pathlib.Path.home())), f"got {_default}")
ok("QP_DB overrides it", (lambda: (
    os.environ.__setitem__('QP_DB', str(_root / 'env.db')),
    store._default_db() == _root / 'env.db',
    os.environ.pop('QP_DB'))[1])())

# The migration: an existing in-repo file is copied to the new home, once, and
# the original is left alone so a failed upgrade loses nothing.
legacy = _root / 'legacy' / 'platform.db'
legacy.parent.mkdir(parents=True, exist_ok=True)
# Point the legacy path at nothing while BUILDING the fixture, or creating it
# triggers the very migration under test and copies the real database in.
store._LEGACY_DB = _root / 'does-not-exist.db'
store._DB = legacy
store._conn = None
os.environ['QP_STRATEGY_BACKUP'] = str(_root / 'nobackup')
store.save_strategy({'name': 'Built in the browser', 'rules': [1]})

store._LEGACY_DB = legacy
# QP_DB, not a bare assignment: the migration only ever fills the DEFAULT
# location, so that a test's temp file — or anyone's deliberate override —
# is never quietly loaded with the box's real strategies.
os.environ['QP_DB'] = str(_root / 'moved' / 'platform.db')
store._DEFAULT_DB = store._default_db()
store._DB = store._DEFAULT_DB
store._conn = None
note = store._migrate_legacy_db()
ok("an in-repo database is carried across on first boot", note and 'moved' in note, note)
ok("and the old file is left where it was", legacy.exists())
ok("the strategies came with it",
   [s['name'] for s in store.list_strategies()] == ['Built in the browser'],
   store.list_strategies())

store._conn = None
ok("migrating twice does not overwrite the new file",
   store._migrate_legacy_db() is None)

# _DB moved away from wherever the default resolves to — which is what every
# other test in this repo does — must not be back-filled from the real box.
store._DB = _root / 'elsewhere.db'
ok("a database pointed somewhere deliberate is never back-filled",
   store._migrate_legacy_db() is None and not (_root / 'elsewhere.db').exists())

os.environ.pop('QP_DB', None)
store._LEGACY_DB = _repo_chart / 'platform.db'


# ── PART B · a human's save outranks the bundle ─────────────────────────────
print("PART B — a strategy a human saved is not overwritten by the bundle")

fresh('b.db', _root / 'b-backup')
seeds = _root / 'seeds-b'
seeds.mkdir(exist_ok=True)

# A bundled scalp with NO `_keep_user_edits` — the exact shape of the seven that
# were losing edits. Version 1 is what shipped first; version 2 is a later
# deploy of the same strategy.
(seeds / 'scalps.json').write_text(json.dumps([
    {'name': 'HitchHiker Scalp', 'rules': ['bundle v1']},
    {'name': 'Back$ide Scalp', 'rules': ['bundle v1']},
]))
store.seed_strategies(seeds)
by = {s['name']: s for s in store.list_strategies()}
ok("a bundled seed is inserted on a fresh box",
   sorted(by) == ['Back$ide Scalp', 'HitchHiker Scalp'], sorted(by))
ok("and is not marked as user-edited",
   not by['HitchHiker Scalp'].get('_user_edited'))

# The user opens one in the builder and changes it.
edited = store.save_strategy({'id': by['HitchHiker Scalp']['id'],
                              'name': 'HitchHiker Scalp', 'rules': ['MY EDIT']},
                             user_edit=True)
ok("a save through the builder marks the row as user-edited",
   edited.get('_user_edited') is True, edited)

# A deploy ships a new bundle and the server restarts.
(seeds / 'scalps.json').write_text(json.dumps([
    {'name': 'HitchHiker Scalp', 'rules': ['bundle v2']},
    {'name': 'Back$ide Scalp', 'rules': ['bundle v2']},
]))
store.seed_strategies(seeds)
by = {s['name']: s for s in store.list_strategies()}
ok("THE EDIT SURVIVES THE DEPLOY",
   by['HitchHiker Scalp']['rules'] == ['MY EDIT'], by['HitchHiker Scalp'])
ok("while an untouched scalp still tracks the bundle",
   by['Back$ide Scalp']['rules'] == ['bundle v2'], by['Back$ide Scalp'])

# The flag is STICKY: assigning tools is not a user edit and must not clear it.
cur = by['HitchHiker Scalp']
store.set_tools(cur['id'], [])
store.seed_strategies(seeds)
by = {s['name']: s for s in store.list_strategies()}
ok("assigning tools later does not clear the protection",
   by['HitchHiker Scalp']['rules'] == ['MY EDIT'], by['HitchHiker Scalp'])

# Deleting it is how you ask for the bundled version back.
store.delete_strategy(by['HitchHiker Scalp']['id'])
store.seed_strategies(seeds)
by = {s['name']: s for s in store.list_strategies()}
ok("deleting it restores the bundled version on the next start",
   by['HitchHiker Scalp']['rules'] == ['bundle v2'], by['HitchHiker Scalp'])


# ── PART C · the plain-text copy ────────────────────────────────────────────
print("PART C — a second copy, in plain text")

bdir = _root / 'c-backup'
fresh('c.db', bdir)
store.save_strategy({'name': 'My PML break', 'rules': ['a'], 'tools': []},
                    user_edit=True)
files = sorted(p.name for p in bdir.glob('*.json'))
ok("every save writes a JSON copy", files == ['My PML break.json'], files)

doc = json.loads((bdir / 'My PML break.json').read_text())
ok("the copy holds the authored document, not the derived fields",
   doc.get('name') == 'My PML break' and 'exit_protocol' not in doc
   and 'id' not in doc, doc)

# The database, wiped. This is the case the whole part exists for.
store._LEGACY_DB = _root / 'no-legacy.db'
store._DB = _root / 'c-wiped.db'
store._conn = None
ok("a wiped database starts empty", store.list_strategies() == [])
n = store.restore_strategies()
ok("the copies are read back", n == 1 and
   [s['name'] for s in store.list_strategies()] == ['My PML break'],
   store.list_strategies())

ok("a restore into a database that already has rows does nothing",
   store.restore_strategies() == 0)

store.delete_strategy(store.list_strategies()[0]['id'])
ok("deleting a strategy removes its copy too, so it does not come back",
   not (bdir / 'My PML break.json').exists())

store._DB = _saved_db
store._conn = None
os.environ.pop('QP_STRATEGY_BACKUP', None)


# ── PART C2 · a strategy of MINE, bundled into the repository ───────────────
#
# The database and the JSON copies both live on one box. A strategy that exists
# only there is one disk away from gone. chart/seeds/*.json is the only copy
# that is in git — on GitHub, on every clone, and restored automatically on a
# box that does not have it. tools/seed_from_db.py is how a strategy joins it,
# and `_keep_user_edits` is what stops the bundle from then overwriting the
# edits that follow.
print("PART C2 — a strategy of mine, bundled")

fresh('c2.db', _root / 'c2-backup')
seeds2 = _root / 'seeds-c2'
seeds2.mkdir(exist_ok=True)

built = store.save_strategy({'name': 'Test', 'side': 'long', 'tools': [],
                             'entry': {'logic': 'AND', 'rules': ['v1']},
                             'risk': {'window_start': 930, 'window_end': 1130}},
                            user_edit=True)

# What seed_from_db writes: the authored document, plus the restore-only flag.
seed = {k: v for k, v in built.items()
        if k not in ('id', 'created_at', 'updated_at', 'exit_protocol',
                     '_seed', '_user_edited')}
seed['_keep_user_edits'] = True
(seeds2 / 'test.json').write_text(json.dumps(seed))
ok("the exported seed carries the strategy and the restore-only flag",
   seed['name'] == 'Test' and seed['entry']['rules'] == ['v1']
   and seed['_keep_user_edits'] is True, seed)
ok("and none of the fields a READ adds",
   not any(k in seed for k in ('id', 'exit_protocol', 'updated_at')), sorted(seed))

# The disk dies. New box, empty database, same repository.
fresh('c2-newbox.db', _root / 'c2-newbox-backup')
ok("the new box starts with nothing", store.list_strategies() == [])
store.seed_strategies(seeds2)
back = store.list_strategies()
ok("THE STRATEGY COMES BACK FROM THE REPOSITORY",
   [b['name'] for b in back] == ['Test'] and back[0]['entry']['rules'] == ['v1'],
   back)

# …and a later edit is not undone by the next deploy.
store.save_strategy({'id': back[0]['id'], 'name': 'Test', 'side': 'long',
                     'entry': {'logic': 'AND', 'rules': ['v2 — edited today']}},
                    user_edit=True)
store.seed_strategies(seeds2)
ok("an edit made afterwards survives the sync",
   store.list_strategies()[0]['entry']['rules'] == ['v2 — edited today'],
   store.list_strategies()[0])

# A seed naming a tool this box does not have must cost only itself.
fresh('c2-badtool.db', _root / 'c2-bad-backup')
seeds3 = _root / 'seeds-c2-bad'
seeds3.mkdir(exist_ok=True)
(seeds3 / 'a-bad.json').write_text(json.dumps(
    {'name': 'Bad tool', 'side': 'long', 'tools': ['T999'],
     'entry': {'logic': 'AND', 'rules': []}, '_keep_user_edits': True}))
(seeds3 / 'b-good.json').write_text(json.dumps(
    {'name': 'Good', 'side': 'long', 'entry': {'logic': 'AND', 'rules': []},
     '_keep_user_edits': True}))
store.seed_strategies(seeds3)
ok("a seed naming an unknown tool is skipped, not fatal…",
   [s['name'] for s in store.list_strategies()] == ['Good'],
   [s['name'] for s in store.list_strategies()])


# ── PART D · every route is bound to the handler it names ───────────────────
#
# `@app.get('/api/backtest/{bid}/report')` had drifted onto `_warn_html`, a
# private helper that takes `warn: list`. FastAPI does what it is told: the
# report URL became a route demanding a body field called `warn`, and pressing
# Report answered
#
#     {"detail":[{"type":"missing","loc":["body","warn"],...}]}
#
# Nothing failed at import, nothing failed at startup, and the suite did not
# look at the routing table at all. A decorator one line above the wrong `def`
# is a two-character mistake with no other symptom, so it is checked here.
print("PART D — the routing table")

from chart import server as srv                              # noqa: E402

_routes = [(getattr(r, 'path', ''), getattr(r, 'endpoint', None),
            sorted(getattr(r, 'methods', []) or []))
           for r in srv.app.routes if getattr(r, 'endpoint', None)]

_private = [(p, fn.__name__) for p, fn, _m in _routes if fn.__name__.startswith('_')]
ok("no route is bound to a private helper", not _private, _private)

ok("the report route reaches backtest_report",
   any(p == '/api/backtest/{bid}/report' and fn.__name__ == 'backtest_report'
       for p, fn, _m in _routes),
   [(p, fn.__name__) for p, fn, _m in _routes if p.endswith('/report')])

# The same mistake wearing a different name. FastAPI decides where an argument
# comes from by its ANNOTATION: a scalar (`name: str`) becomes a query
# parameter, which a browser GET can supply. A container (`warn: list`) becomes
# a required BODY field, which a GET cannot supply at all — so a required
# container argument on a GET route is always a wiring error, never a design.
import inspect                                               # noqa: E402
_CONTAINERS = (list, dict, set, tuple)
_bad = []
for path, fn, methods in _routes:
    if 'GET' not in methods or fn.__module__.startswith('fastapi'):
        continue
    for pname, param in inspect.signature(fn).parameters.items():
        if param.default is not inspect.Parameter.empty:
            continue
        if '{' + pname + '}' in path or pname in ('request', 'self'):
            continue
        ann = param.annotation
        if ann is inspect.Parameter.empty or ann in _CONTAINERS:
            _bad.append((path, fn.__name__, pname, getattr(ann, '__name__', ann)))
ok("no GET route demands a body field", not _bad, _bad)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
