"""Audit part 4 — rule-level SIGNAL offset ('ago')."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS=0; FAIL=0; FAILS=[]
def chk(name, got, exp):
    global PASS, FAIL
    g=list(np.asarray(got).tolist()); e=list(exp)
    ok=(len(g)==len(e)) and all(a==b for a,b in zip(g,e))
    if ok: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name}\n     got={g}\n     exp={e}")

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

# plain condition true at idx 1,4 -> ago 2 shifts to 3,6
b=bars_from(close=[9,11,9,9,12,9,9,9])
chk('signal ago=2', S._eval_rule(rule(P(),'gt',C(10),offset=2), b, None),
    [False,False,False,True,False,False,True,False])
chk('signal ago=0 unchanged', S._eval_rule(rule(P(),'gt',C(10),offset=0), b, None),
    [False,True,False,False,True,False,False,False])
chk('signal ago overflow -> never', S._eval_rule(rule(P(),'gt',C(10),offset=99), b, None), [False]*8)

# bounce shifted right: bounce fires idx2 (from part-3 'real pullback' case) -> ago 1 = idx3
bg=bars_from(close=[101.0, 100.8, 101.2, 101.3],
             o    =[101.0, 101.0, 100.9, 101.2],
             h    =[101.5, 101.2, 101.4, 101.5],
             l    =[100.8, 100.4, 100.05, 101.1])
chk('bounce base fires idx2', S._eval_rule(rule(P(),'bounce_up',C(100)), bg, None), [False,False,True,False])
chk('bounce ago=1 fires idx3', S._eval_rule(rule(P(),'bounce_up',C(100),offset=1), bg, None), [False,False,False,True])

# order: hold-for FIRST, then ago. gt held on 3,4,5 -> for2 true at 4,5 -> ago1 true at 5,6
b2=bars_from(close=[9,9,9,11,12,13,9,9])
chk('for2 then ago1', S._eval_rule(rule(P(),'gt',C(10),for_bars=2,offset=1), b2, None),
    [False,False,False,False,False,True,True,False])

# composition: A(now) AND B(ago 2) — the "sequence by exact distance" pattern
A=rule(P(),'gt',C(10),offset=2)      # was above 2 bars ago
Br=rule(P(),'lt',C(10))              # is below now
b3=bars_from(close=[11,9,9,11,9,9])
chk('above[2] AND below[now]', S._eval_group({'logic':'AND','rules':[A,Br]}, b3, None),
    [False,False,True,False,False,True])

print("== hold: forward-fill a sparse primitive into a persistent level ==")
# a sparse operand (a primitive that's NaN except a few bars) — simulate with a
# pivot_high. Craft one clean swing high; 'hold' must carry it forward flat.
import tools.compare_server as cs
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; FAILS.append(name); print(f"  FAIL {name}: got={got!r} exp={exp!r}")
bh = bars_from(close=[10,10.1,10.2,10.3,10.2,10.1,10,10,10,10,10,10,10],
               h    =[10.1,10.2,10.3,10.5,10.3,10.2,10.1,10.1,10.1,10.1,10.1,10.1,10.1])  # peak high 10.5 @ idx3
ctx3 = {'symbol':'X','tf':'1m','start':bh.index[0],'end':bh.index[-1]}
raw = S._operand_array({'kind':'primitive','key':'structure.pivot_high','source':'high',
                        'params':{'left':2,'right':2}}, bh, ctx3)
held = S._operand_array({'kind':'primitive','key':'structure.pivot_high','source':'high',
                         'params':{'left':2,'right':2},'hold':True}, bh, ctx3)
# raw prints 10.5 only on the confirmation bar (idx 5 = peak idx3 + right 2), NaN else
chkv('raw pivot is sparse (one real value)', int((~np.isnan(raw)).sum()), 1)
chkv('raw value is the swing high', round(float(raw[np.nanargmax(np.where(np.isnan(raw),-1,raw))]),2), 10.5)
# held: NaN until confirmation, then 10.5 carried forward on every later bar
first = int(np.argmax(~np.isnan(held)))
chkv('held is NaN before the pivot confirms', bool(np.isnan(held[first-1])) if first>0 else True, True)
chkv('held carries 10.5 forward to the last bar', round(float(held[-1]),2), 10.5)
chkv('held has no gaps after it starts', int(np.isnan(held[first:]).sum()), 0)

print(f"\nPASS={PASS} FAIL={FAIL}")
if FAILS: print("FAILURES:", FAILS)
sys.exit(1 if FAIL else 0)
