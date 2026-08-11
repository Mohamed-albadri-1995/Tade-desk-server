"""Audit part 6 — Fable-5 ownership fixes: pct-op negative refs, k clamp,
unprotected-entry skip, open-trade reporting, store meta strip."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS=0; FAIL=0
def chk(name, got, exp):
    global PASS, FAIL
    g=list(np.asarray(got).tolist())
    ok=(len(g)==len(exp)) and all(a==b for a,b in zip(g,exp))
    if ok: PASS+=1
    else: FAIL+=1; print(f"  FAIL {name}\n     got={g}\n     exp={list(exp)}")
def chkv(name, got, exp):
    global PASS, FAIL
    if got==exp: PASS+=1
    else: FAIL+=1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars_from(close, o=None, h=None, l=None):
    n=len(close)
    idx=pd.date_range('2024-01-02 09:30', periods=n, freq='1min', tz='America/New_York').tz_convert('UTC')
    close=np.array(close,float)
    o=np.array(o,float) if o is not None else close.copy()
    h=np.array(h,float) if h is not None else np.maximum(o,close)
    l=np.array(l,float) if l is not None else np.minimum(o,close)
    return pd.DataFrame({'open':o,'high':h,'low':l,'close':close,'volume':np.full(n,1000.0)}, index=idx)
P=lambda f='close': {'kind':'price','field':f}
C=lambda x: {'kind':'const','value':x}
def rule(left,op,right=None,**kw):
    r={'left':left,'op':op}
    if right is not None: r['right']=right
    r.update(kw); return r

print("== 1. pct ops with NEGATIVE reference ==")
# ref -10, pct 10 -> threshold -10+1=-9: L must be >= -9
b=bars_from(close=[-9.5,-9.0,-8.0])
chk('gt_pct neg ref', S._eval_rule(rule(P(),'gt_pct',C(-10),op_params={'pct':10}), b, None), [False,True,True])
# lt_pct: threshold -10-1=-11: L must be <= -11
b2=bars_from(close=[-10.5,-11.0,-12.0])
chk('lt_pct neg ref', S._eval_rule(rule(P(),'lt_pct',C(-10),op_params={'pct':10}), b2, None), [False,True,True])
# positive ref unchanged: 100 +1% -> >=101
b3=bars_from(close=[100.5,101.0,102.0])
chk('gt_pct pos ref regress', S._eval_rule(rule(P(),'gt_pct',C(100),op_params={'pct':1}), b3, None), [False,True,True])

print("== 2. ATLEAST k clamp ==")
bg=bars_from(close=[9,11,9])
A=rule(P(),'gt',C(10)); B=rule(P(),'gt',C(100))
chk('k=0 clamped to 1 (not always-true)', S._eval_group({'logic':'ATLEAST','k':0,'rules':[A,B]}, bg, None), [False,True,False])
chk('k=None clamped', S._eval_group({'logic':'ATLEAST','k':None,'rules':[A,B]}, bg, None), [False,True,False])

print("== 3. unprotected-entry skip ==")
# anchored SL whose line is NaN early (offset makes first 2 bars NaN):
# entry signal at bar1 must be SKIPPED, first valid entry at bar2.
b4=bars_from(close=[100,100,100,100,100], l=[99.8]*5, h=[100.2]*5)
# value=1 -> level = anchor*0.99 = 99, safely BELOW the 99.8 lows (no trigger)
risk={'sl':{'type':'prim','value':1,'anchor':{'kind':'price','field':'close','offset':2}}}
ent=np.array([False,True,True,False,False])
tr,slv,_,op=S._pair_trades(b4, list(range(5)), ent, np.zeros(5,bool), 'long', risk, None)
chkv('entry@1 skipped (SL NaN), enters @2', op['ei'] if op else None, 2)
chkv('no closed trades', len(tr), 0)
# ATR-based SL, ATR NaN everywhere (no ctx) -> all entries skipped, no trade at all
risk2={'sl':{'type':'atr','value':1.5}}
tr2,_,_,op2=S._pair_trades(b4, list(range(5)), ent, np.zeros(5,bool), 'long', risk2, None)
chkv('ATR unpriceable -> no entries at all', (len(tr2), op2), (0, None))
# SL type set but value blank -> treated as OFF (enters unprotected is the
# explicit user choice of leaving it blank)
risk3={'sl':{'type':'pct','value':None}}
tr3,_,_,op3=S._pair_trades(b4, list(range(5)), ent, np.zeros(5,bool), 'long', risk3, None)
chkv('blank value = SL off, entry allowed', op3['ei'] if op3 else None, 1)

print("== 4. open-trade reporting ==")
b5=bars_from(close=[100,100,102,104])
tr5,_,_,op5=S._pair_trades(b5, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'long', {}, None)
chkv('open trade ei', op5['ei'], 1)
chkv('open trade ret 4%', round(op5['ret'],4), 0.04)
# closed trade -> no open
tr6,_,_,op6=S._pair_trades(b5, list(range(4)), np.array([False,True,False,False]), np.array([False,False,False,True]), 'long', {}, None)
chkv('closed -> open_trade None', (len(tr6), op6), (1, None))
# short open trade ret sign
tr7,_,_,op7=S._pair_trades(b5, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'short', {}, None)
chkv('short open ret -4%', round(op7['ret'],4), -0.04)

print("== 5. store strips meta ==")
import importlib, tempfile, pathlib
import chart.store as store
store._DB = pathlib.Path(tempfile.mkdtemp())/'t.db'; store._conn=None
s1=store.save_strategy({'name':'x','entry':{'rules':[]},'exit':{'rules':[]}})
s2=store.save_strategy({**s1, 'name':'x2'})     # load->edit->save cycle carries id/updated_at
import sqlite3, json as J
row=store._db().execute('SELECT data FROM strategies WHERE id=?',(s2['id'],)).fetchone()
raw=J.loads(row['data'])
chkv('no updated_at embedded', 'updated_at' in raw, False)
chkv('no id embedded', 'id' in raw, False)
chkv('same row updated', s2['id'], s1['id'])

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
