"""Audit part 2 — new features: pct ops, cross+hold, anchored SL/TP, slope v2."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S
from qp.primitives.trend import slope_strength

PASS=0; FAIL=0; FAILS=[]
def chk(name, got, exp):
    global PASS, FAIL
    g=list(np.asarray(got).tolist()); e=list(exp)
    ok=(len(g)==len(e)) and all((a==b) or (isinstance(a,float) and isinstance(b,float) and np.isnan(a) and np.isnan(b)) for a,b in zip(g,e))
    if ok: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name}\n     got={g}\n     exp={e}")
def chkv(name, got, exp):
    global PASS, FAIL
    if got==exp: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name}: got={got!r} exp={exp!r}")
def chktrue(name, cond, info=''):
    global PASS, FAIL
    if cond: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name} {info}")

def bars_from(close=None, o=None, h=None, l=None, n=None):
    if close is not None: n=len(close)
    idx=pd.date_range('2024-01-02 09:30', periods=n, freq='1min', tz='America/New_York').tz_convert('UTC')
    close=np.array(close,float) if close is not None else np.full(n,100.0)
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

print("== A. gt_pct / lt_pct ==")
# ref 100; 1% above = >=101; 1% below = <=99
b=bars_from(close=[100.5,101.0,102.0,99.5,99.0,97.0])
chk('gt_pct 1%', S._eval_rule(rule(P(),'gt_pct',C(100),op_params={'pct':1}), b, None),
    [False,True,True,False,False,False])
chk('lt_pct 1%', S._eval_rule(rule(P(),'lt_pct',C(100),op_params={'pct':1}), b, None),
    [False,False,False,False,True,True])
chk('gt_pct 0% == ge', S._eval_rule(rule(P(),'gt_pct',C(100),op_params={'pct':0}), b, None),
    [True,True,True,False,False,False])

print("== B. cross_above + for_bars (crossed THEN state held) ==")
# closes: 9, 11(cross), 12, 13 -> fb=3 fires at idx3 (cross@1, held 1..3)
b1=bars_from(close=[9,11,12,13])
chk('cross+hold3 held', S._eval_rule(rule(P(),'cross_above',C(10),for_bars=3), b1, None),
    [False,False,False,True])
# closes: 9, 11(cross), 9(dip), 13 -> never fires (state broke)
b2=bars_from(close=[9,11,9,13])
chk('cross+hold3 broke', S._eval_rule(rule(P(),'cross_above',C(10),for_bars=3), b2, None),
    [False,False,False,False])
# re-cross at idx3 then held 3,4,5 -> fires idx5
b3=bars_from(close=[9,11,9,11,12,13])
chk('cross+hold3 recross', S._eval_rule(rule(P(),'cross_above',C(10),for_bars=3), b3, None),
    [False,False,False,False,False,True])
# cross_below symmetric: 11,9(cross),8,7 fb=3 -> fires idx3
b4=bars_from(close=[11,9,8,7])
chk('crossdn+hold3', S._eval_rule(rule(P(),'cross_below',C(10),for_bars=3), b4, None),
    [False,False,False,True])
# fb larger than series
b5=bars_from(close=[9,11])
chk('cross+hold overflow', S._eval_rule(rule(P(),'cross_above',C(10),for_bars=5), b5, None),
    [False,False])

print("== C. anchored SL/TP (@ line) ==")
# LONG, SL anchored to a trailing line = price field 'open' here (we control it).
# entry idx1 @close 100. line(open): [98,98,98.5,99.2,99.5]; pct=0 -> level=line.
# lows: stay above until idx4 low 99.3 <= 99.5 -> SL at 99.5 idx4.
bA=bars_from(close=[100,100,100.5,100.4,100.2],
             o=[98,98,98.5,99.2,99.5],
             h=[100.5,100.5,101,101,100.6],
             l=[99.9,99.8,99.6,99.4,99.3])
risk={'sl':{'type':'prim','value':0,'anchor':{'kind':'price','field':'open'}}}
tr,_SL,_TP,_OP=S._pair_trades(bA, list(range(5)), np.array([False,True,False,False,False]), np.zeros(5,bool), 'long', risk, None)
chkv('anchored SL trails: 1 trade', len(tr), 1)
if tr:
    chkv('anchored SL reason', tr[0]['reason'], 'SL')
    chkv('anchored SL bar', tr[0]['xi'], 4)
    chkv('anchored SL price', round(tr[0]['exit'],4), 99.5)
# pct beyond: 1% below the line for long -> level=line*0.99; low never reaches -> no exit
risk2={'sl':{'type':'prim','value':1,'anchor':{'kind':'price','field':'open'}}}
tr2,_SL,_TP,_OP=S._pair_trades(bA, list(range(5)), np.array([False,True,False,False,False]), np.zeros(5,bool), 'long', risk2, None)
chkv('anchored SL 1% below: no trigger', len(tr2), 0)
# TP anchored for long: line const 101 (via const operand), high 101 @idx2 -> TP idx2 @101
riskT={'tp':{'type':'prim','value':0,'anchor':{'kind':'const','value':101}}}
trT,_SL,_TP,_OP=S._pair_trades(bA, list(range(5)), np.array([False,True,False,False,False]), np.zeros(5,bool), 'long', riskT, None)
chkv('anchored TP reason', trT[0]['reason'] if trT else None, 'TP')
chkv('anchored TP bar', trT[0]['xi'] if trT else None, 2)
# SHORT: SL anchored above -> level=line*(1+pct). line const 101, pct 0; high 101.5 idx2 -> SL
riskS={'sl':{'type':'prim','value':0,'anchor':{'kind':'const','value':101}}}
bS=bars_from(close=[100,100,100.8,100], h=[100.2,100.2,101.5,100.4], l=[99,99,100,99])
trS,_SL,_TP,_OP=S._pair_trades(bS, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'short', riskS, None)
chkv('short anchored SL reason', trS[0]['reason'] if trS else None, 'SL')
# NaN warm-up: anchor NaN early bars must not trigger
bN=bars_from(close=[100,100,100,100], l=[98,98,98,98], h=[100,100,100,100])
class _NanOperand: pass
# use offset to force NaN: anchor = price close with offset 10 (all NaN)
riskN={'sl':{'type':'prim','value':0,'anchor':{'kind':'price','field':'close','offset':10}}}
trN,_SL,_TP,_OP=S._pair_trades(bN, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'long', riskN, None)
chkv('NaN anchor never triggers', len(trN), 0)
# protocol: anchored SL beats exit rule on same bar
riskP={'sl':{'type':'prim','value':0,'anchor':{'kind':'const','value':99.5}}}
bP=bars_from(close=[100,100,100], l=[100,100,99.4], h=[100.2,100.2,100.2])
trP,_SL,_TP,_OP=S._pair_trades(bP, list(range(3)), np.array([False,True,False]), np.array([False,False,True]), 'long', riskP, None)
chkv('protocol SL beats exit', trP[0]['reason'] if trP else None, 'SL')

print("== D. fixed SL direction sanity (long below / short above) ==")
risk3={'sl':{'type':'pct','value':1}}
bL=bars_from(close=[100,100,100], l=[100,100,98.9], h=[100,100,100.1])
tl,_SL,_TP,_OP=S._pair_trades(bL, list(range(3)), np.array([False,True,False]), np.zeros(3,bool), 'long', risk3, None)
chkv('long SL below entry', round(tl[0]['exit'],4) if tl else None, 99.0)
bSh=bars_from(close=[100,100,100], h=[100,100,101.1], l=[99,99,99.9])
tsh,_SL,_TP,_OP=S._pair_trades(bSh, list(range(3)), np.array([False,True,False]), np.zeros(3,bool), 'short', risk3, None)
chkv('short SL above entry', round(tsh[0]['exit'],4) if tsh else None, 101.0)

print("== E. slope v2 (residual-normalized) ==")
rng=np.random.default_rng(7)
n=400
noise=rng.normal(0,0.5,n)
flat=100+noise                                  # pure chop
shallow=100+0.05*np.arange(n)+noise             # shallow drift
steep=100+0.5*np.arange(n)+noise                # strong trend
s_flat=slope_strength(flat,12); s_shal=slope_strength(shallow,12); s_steep=slope_strength(steep,12)
fire_flat=np.nanmean(np.abs(s_flat)>=2.0)
chktrue('chop fires <10% at thr 2.0', fire_flat<0.10, f'(got {fire_flat:.1%})')
chktrue('steep >> shallow', np.nanmedian(s_steep) > 3*np.nanmedian(np.abs(s_shal)),
        f'(steep med {np.nanmedian(s_steep):.2f} vs shallow med {np.nanmedian(s_shal):.2f})')
chktrue('steep clean trend strength >= 5', np.nanmedian(s_steep)>=5, f'(got {np.nanmedian(s_steep):.2f})')
chktrue('flat median ~0', abs(np.nanmedian(s_flat))<0.5, f'(got {np.nanmedian(s_flat):.3f})')
down=100-0.5*np.arange(n)+noise
chktrue('down trend negative', np.nanmedian(slope_strength(down,12))<=-5)
# engine flags use the same function + new default threshold 2.0
bU=bars_from(close=list(100+0.5*np.arange(50)+rng.normal(0,0.3,50)))
chktrue('rising fires on trend', bool(S._eval_rule(rule(P(),'rising'), bU, None)[-1]))
bF=bars_from(close=list(100+rng.normal(0,0.3,50)))
r_f=S._eval_rule(rule(P(),'rising'), bF, None); f_f=S._eval_rule(rule(P(),'falling'), bF, None)
neither=1-np.mean(r_f|f_f)
chktrue('chop mostly NEITHER (>=88%)', neither>=0.88, f'(got {neither:.1%})')
# ramp cap
ramp=np.arange(50,dtype=float)
chktrue('perfect ramp capped at 99', np.nanmax(slope_strength(ramp,12))==99.0)

print("\n================  RESULT (part 2)  ================")
print(f"PASS={PASS}  FAIL={FAIL}")
if FAILS: print("FAILURES:", FAILS)
sys.exit(1 if FAIL else 0)
