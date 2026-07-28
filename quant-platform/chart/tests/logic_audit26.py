"""User strategies survive deploys — restore-only seeds.

chart/seeds/*.json are re-synced into the DB at every startup. OUR canonical
scalps must TRACK the bundle (engine fixes must reach them), but a strategy
the user built in the browser must NOT be reverted when they tweak it.

A seed carrying "_keep_user_edits": true is RESTORE-ONLY:
  - absent from the DB  -> inserted (a fresh box / wiped platform.db gets it back)
  - already in the DB   -> left exactly as stored (browser edits survive)

PART A — the restore-only rule itself (insert, then never overwrite).
PART B — canonical seeds still refresh in place (no regression).
PART C — the shipped user seed file is valid and evaluates end-to-end.
"""
import sys, pathlib, json, tempfile, importlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

# isolated DB + seeds dir so the real platform.db is never touched
_tmp = tempfile.TemporaryDirectory()
_root = pathlib.Path(_tmp.name)
import chart.store as store
store._DB = _root / 'test.db'
store._conn = None
seeds = _root / 'seeds'
seeds.mkdir()
store_seeds_dir = pathlib.Path(store.__file__).resolve().parent / 'seeds'

def _seed_file(objs):
    (seeds / 'x.json').write_text(json.dumps(objs))

# point seed_strategies at the temp dir by monkeypatching Path resolution
_orig = store.seed_strategies
def seed_from(dirpath):
    """Run the real logic against `dirpath` by temporarily swapping __file__."""
    src = pathlib.Path(store.__file__).resolve().parent
    import types
    code = _orig.__code__
    # simplest faithful approach: call the real function with the seeds dir
    # swapped in via a shim module attribute
    return _run_seed(dirpath)

def _run_seed(dirpath):
    """Reimplements only the DIRECTORY choice; all decision logic is the
    real store.seed_strategies body, exercised by calling it with the module's
    seeds dir temporarily replaced."""
    real_parent = pathlib.Path(store.__file__).resolve().parent
    target = real_parent / 'seeds'
    backup = None
    if target.exists():
        backup = target.with_name('seeds__bak_test')
        target.rename(backup)
    try:
        import shutil
        shutil.copytree(dirpath, target)
        return store.seed_strategies()
    finally:
        import shutil
        if target.exists():
            shutil.rmtree(target)
        if backup is not None:
            backup.rename(target)

print("=" * 64)
print("PART A — restore-only seed: insert once, then never overwrite")
print("=" * 64)
USER = {'name': 'My Setup', 'side': 'long', '_keep_user_edits': True,
        'entry': {'logic': 'AND', 'rules': [
            {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
             'right': {'kind': 'const', 'value': 1}}]},
        'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
_seed_file([USER])
n1 = _run_seed(seeds)
got = [s for s in store.list_strategies() if s['name'] == 'My Setup']
ok("inserted when missing (a fresh box gets it back)", n1 == 1 and len(got) == 1)

# user edits it in the browser
edited = dict(got[0])
edited['risk'] = {'window_start': 1030, 'window_end': 1200}
store.save_strategy(edited)
n2 = _run_seed(seeds)                       # restart happens
after = [s for s in store.list_strategies() if s['name'] == 'My Setup'][0]
ok("restart does NOT revert the user's edit",
   after['risk'].get('window_start') == 1030 and n2 == 0,
   f"risk={after.get('risk')} changed={n2}")

# deleting it (wiped DB) restores the bundled copy
store.delete_strategy(after['id'])
n3 = _run_seed(seeds)
back = [s for s in store.list_strategies() if s['name'] == 'My Setup']
ok("after a wipe it is restored from the bundle",
   n3 == 1 and len(back) == 1 and not back[0]['risk'], f"{back}")

print("=" * 64)
print("PART B — canonical seeds still refresh in place (no regression)")
print("=" * 64)
CANON = {'name': 'Canon', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': [
             {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
              'right': {'kind': 'const', 'value': 1}}]},
         'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
_seed_file([CANON])
_run_seed(seeds)
cur = [s for s in store.list_strategies() if s['name'] == 'Canon'][0]
cur2 = dict(cur); cur2['risk'] = {'window_start': 999}
store.save_strategy(cur2)                  # simulate drift
n4 = _run_seed(seeds)
fixed = [s for s in store.list_strategies() if s['name'] == 'Canon'][0]
ok("a canonical seed IS restored to the bundle (engine fixes reach it)",
   n4 == 1 and not fixed['risk'], f"risk={fixed.get('risk')} changed={n4}")

print("=" * 64)
print("PART C — the shipped user seed file is valid and evaluates")
print("=" * 64)
uf = store_seeds_dir / 'user_strategies.json'
ok("chart/seeds/user_strategies.json exists", uf.is_file())
docs = json.loads(uf.read_text())
pml = [d for d in docs if d['name'] == 'PML breakout']
ok("carries PML breakout, marked restore-only",
   len(pml) == 1 and pml[0].get('_keep_user_edits') is True)
p = pml[0]
ok("side short, 7 entry rules, window 940-1010",
   p['side'] == 'short' and len(p['entry']['rules']) == 7
   and (p['risk']['window_start'], p['risk']['window_end']) == (940, 1010),
   f"{p['side']} {len(p['entry']['rules'])} {p['risk'].get('window_start')}")

# end-to-end: it must actually evaluate through the engine
import tools.compare_server as cs
import chart.strategy as S
ET = 'America/New_York'
idx = pd.DatetimeIndex([pd.Timestamp('2026-07-14 08:00', tz=ET) + pd.Timedelta(minutes=2 * i)
                        for i in range(240)]).tz_convert('UTC')
px = np.linspace(10.0, 9.0, 240)
df = pd.DataFrame({'open': px + 0.02, 'high': px + 0.05, 'low': px - 0.05,
                   'close': px, 'volume': np.full(240, 1e5)}, index=idx)
class Stub:
    def load(self, sym, tf, start, end):
        return df[(df.index >= start) & (df.index < end)]
cs._LOADERS['seedtest'] = Stub()
r = S.evaluate(p, 'X', '2m', 2, feed='seedtest', view='all',
               asof='2026-07-14', fill='next_open')
ok("evaluates without error through the real engine",
   r.get('ok') is True and r.get('error') is None, f"err={r.get('error')}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
