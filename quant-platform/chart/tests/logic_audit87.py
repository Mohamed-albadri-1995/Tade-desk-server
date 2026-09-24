"""The Alpaca pair the deploy writes to .env is the one qp uses.

2026-09-24: the deploy found the desk-wide Alpaca pair refused, replaced it
with a working one, wrote it to quant-platform/.env and restarted qp — and
qp's alpaca feed was still refused. The old pair was in the environment pm2
handed qp, and the loader let the environment win for every key: "[env]
loaded 1 value(s) from .env" from a file holding three.

Checks, by running the loader on a real file:
  1. an inherited APCA pair is REPLACED by the .env pair (fails on the old loader);
  2. any other inherited key still wins over the file, as before;
  3. an APCA key absent from the environment is loaded as before.
"""
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.server as srv                                           # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}   {extra}')


KEEP = {k: os.environ.get(k) for k in
        ('APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'POLYGON_API_KEY')}
env = pathlib.Path(tempfile.mkdtemp()) / '.env'
env.write_text('APCA_API_KEY_ID=PKTESTNEWPAIRNEWPAIR\n'
               'APCA_API_SECRET_KEY=new-secret\n'
               'POLYGON_API_KEY=from-file\n')
try:
    print('== 1. the deploy-written pair beats a stale inherited one ==')
    os.environ['APCA_API_KEY_ID'] = 'PKTESTOLDDEADOLDDEAD'
    os.environ['APCA_API_SECRET_KEY'] = 'old-secret'
    os.environ['POLYGON_API_KEY'] = 'set-by-launcher'
    n = srv._load_dotenv(env)
    ok('APCA_API_KEY_ID is the .env one', os.environ['APCA_API_KEY_ID'] == 'PKTESTNEWPAIRNEWPAIR',
       os.environ['APCA_API_KEY_ID'])
    ok('APCA_API_SECRET_KEY is the .env one', os.environ['APCA_API_SECRET_KEY'] == 'new-secret')
    print('== 2. every other key: the launcher still wins ==')
    ok('POLYGON_API_KEY kept from the environment',
       os.environ['POLYGON_API_KEY'] == 'set-by-launcher')
    ok('the count says two were taken from the file', n == 2, n)

    print('== 3. nothing inherited: loaded as before ==')
    for k in ('APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'POLYGON_API_KEY'):
        os.environ.pop(k, None)
    n = srv._load_dotenv(env)
    ok('all three loaded', n == 3 and os.environ['POLYGON_API_KEY'] == 'from-file', n)
    ok('a second load changes nothing', srv._load_dotenv(env) == 0)
finally:
    for k, v in KEEP.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
