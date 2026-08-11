"""Audit part 5 — SL/TP level views (what gets drawn)."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S
PASS=0; FAIL=0
def chk(name, got, exp):
    global PASS, FAIL
    g=['-' if v!=v else round(float(v),2) for v in got]
    ok = g==exp
    if ok: PASS+=1
    else: FAIL+=1; print(f"  FAIL {name}\n     got={g}\n     exp={exp}")
def bars_from(close, o=None, h=None, l=None):
    n=len(close)
    idx=pd.date_range('2024-01-02 09:30', periods=n, freq='1min', tz='America/New_York').tz_convert('UTC')
    close=np.array(close,float)
    o=np.array(o,float) if o is not None else close.copy()
    h=np.array(h,float) if h is not None else np.maximum(o,close)
    l=np.array(l,float) if l is not None else np.minimum(o,close)
    return pd.DataFrame({'open':o,'high':h,'low':l,'close':close,'volume':np.full(n,1000.0)}, index=idx)

# fixed 1% SL long, entry idx1@100, SL hits idx3 (low 98.9) -> level 99 drawn bars 1..3, NaN outside
b=bars_from(close=[100,100,100,100,100], l=[99.8,99.8,99.5,98.9,99.8], h=[100.2]*5)
risk={'sl':{'type':'pct','value':1}}
tr,slv,tpv,_op=S._pair_trades(b, list(range(5)), np.array([False,True,False,False,False]), np.zeros(5,bool), 'long', risk, None)
chk('fixed SL view flat during trade', slv, ['-',99.0,99.0,99.0,'-'])
chk('no TP -> TP view empty', tpv, ['-','-','-','-','-'])
# anchored SL trails: anchor = open ramp
b2=bars_from(close=[100,100,100.5,100.4], o=[98.0,98.2,98.6,99.0], h=[100.5]*4, l=[99.5,99.5,99.4,99.3])
risk2={'sl':{'type':'prim','value':0,'anchor':{'kind':'price','field':'open'}}}
tr2,slv2,_,_op2=S._pair_trades(b2, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'long', risk2, None)
chk('anchored SL view trails the line', slv2, ['-',98.2,98.6,99.0])
print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
