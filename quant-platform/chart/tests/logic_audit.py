"""Deep logic-correctness audit of the strategy engine.
Feeds controlled data with HAND-COMPUTED expected results and asserts the
engine produces exactly that. No market data — pure logic verification."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S
import tools.compare_server as cs

PASS=0; FAIL=0; FAILS=[]
def chk(name, got, exp):
    global PASS, FAIL
    g=list(np.asarray(got).tolist()); e=list(exp)
    ok=(len(g)==len(e)) and all((a is b) or (a==b) or (isinstance(a,float) and isinstance(b,float) and np.isnan(a) and np.isnan(b)) for a,b in zip(g,e))
    if ok: PASS+=1
    else:
        FAIL+=1; FAILS.append(name); print(f"  FAIL {name}\n     got={g}\n     exp={e}")
def chkval(name, got, exp):
    global PASS, FAIL
    ok = (got==exp) or (isinstance(got,float) and isinstance(exp,float) and np.isnan(got) and np.isnan(exp))
    if ok: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars_from(close=None, o=None, h=None, l=None, v=None, n=None, start='2024-01-02 09:30'):
    if close is not None: n=len(close)
    idx=pd.date_range(start, periods=n, freq='1min', tz='America/New_York').tz_convert('UTC')
    close=np.array(close,float) if close is not None else np.full(n,100.0)
    o=np.array(o,float) if o is not None else close.copy()
    h=np.array(h,float) if h is not None else np.maximum(o,close)
    l=np.array(l,float) if l is not None else np.minimum(o,close)
    v=np.array(v,float) if v is not None else np.full(n,1000.0)
    return pd.DataFrame({'open':o,'high':h,'low':l,'close':close,'volume':v}, index=idx)

P=lambda f='close': {'kind':'price','field':f}
C=lambda x: {'kind':'const','value':x}
def rule(left,op,right=None,**kw):
    r={'left':left,'op':op};
    if right is not None: r['right']=right
    r.update(kw); return r

print("== 1. comparison operators ==")
b=bars_from(close=[9,11,13,16,19,21,14,10])
chk('gt',  S._eval_rule(rule(P(),'gt', C(10)), b, None), [False,True,True,True,True,True,True,False])
chk('lt',  S._eval_rule(rule(P(),'lt', C(20)), b, None), [True,True,True,True,True,False,True,True])
chk('ge',  S._eval_rule(rule(P(),'ge', C(13)), b, None), [False,False,True,True,True,True,True,False])
chk('le',  S._eval_rule(rule(P(),'le', C(13)), b, None), [True,True,True,False,False,False,False,True])
chk('eq',  S._eval_rule(rule(P(),'eq', C(16)), b, None), [False,False,False,True,False,False,False,False])
chk('neq', S._eval_rule(rule(P(),'neq',C(16)), b, None), [True,True,True,False,True,True,True,True])

print("== 2. cross operators ==")
bc=bars_from(close=[8,9,10,11,12,11,10,9])
chk('cross_above', S._eval_rule(rule(P(),'cross_above',C(10)), bc, None), [False,False,False,True,False,False,False,False])
chk('cross_below', S._eval_rule(rule(P(),'cross_below',C(10)), bc, None), [False,False,False,False,False,False,False,True])

print("== 3. offset (n bars ago) ==")
bo=bars_from(close=[5,4,6,3,7], h=[5,4,6,3,7], l=[5,4,6,3,7])
# close > high[1]  → close[i] > high[i-1]
chk('close>high[1]', S._eval_rule(rule(P('close'),'gt',{'kind':'price','field':'high','offset':1}), bo, None),
    [False, False, True, False, True])
# _shift direct
chk('shift2', S._shift(np.array([1.,2,3,4,5]),2), [np.nan,np.nan,1,2,3])
chk('shift0', S._shift(np.array([1.,2,3,4,5]),0), [1,2,3,4,5])
chk('shift_overflow', S._shift(np.array([1.,2,3,4,5]),10), [np.nan]*5)

print("== 4. expr arithmetic (+ nan/div0) ==")
be=bars_from(close=[10,20,30], o=[10,20,30], h=[12,24,33], l=[8,16,27])
# body% via expr = |close-open|... here use (high - low) / close * ... test div
expr_div={'kind':'expr','op':'div','a':P('high'),'b':P('low')}   # high/low
# 12/8=1.5(T), 24/16=1.5(T), 33/27=1.222(F)
chk('expr high/low >1.4', S._eval_rule(rule(expr_div,'gt',C(1.4)), be, None), [True,True,False])
# div by zero -> nan -> comparison False
bz=bars_from(close=[1,2,3])
expr_z={'kind':'expr','op':'div','a':C(5),'b':C(0)}
chk('div0->False', S._eval_rule(rule(expr_z,'gt',C(-1)), bz, None), [False,False,False])
# nested expr: (high-low)/close
nested={'kind':'expr','op':'div','a':{'kind':'expr','op':'sub','a':P('high'),'b':P('low')},'b':P('close')}
arr=S._operand_array(nested, be, None)   # (12-8)/10=0.4,(24-16)/20=0.4,(33-27)/30=0.2
chk('nested expr vals', np.round(arr,4), [0.4,0.4,0.2])

print("== 5. time operand ==")
bt=bars_from(n=6)  # 09:30..09:35 ET -> minutes 570..575
chk('time>=573', S._eval_rule(rule({'kind':'time','field':'minutes'},'ge',C(573)), bt, None),
    [False,False,False,True,True,True])

print("== 6. sustained: for_bars / within_bars ==")
# mask close>10 on [9,11,9,11,12,13] -> [F,T,F,T,T,T]
bs=bars_from(close=[9,11,9,11,12,13])
chk('for_bars=2', S._eval_rule(rule(P(),'gt',C(10),for_bars=2), bs, None), [False,False,False,False,True,True])
chk('within_bars=2', S._eval_rule(rule(P(),'gt',C(10),within_bars=2), bs, None), [False,True,True,True,True,True])

print("== 7. groups AND/OR/ATLEAST/nested ==")
bg=bars_from(close=[9,11,13,16,19,21,14,10])
A=rule(P(),'gt',C(10)); B=rule(P(),'lt',C(20)); Cc=rule(P(),'gt',C(15)); D=rule(P(),'lt',C(12))
chk('AND', S._eval_group({'logic':'AND','rules':[A,B]}, bg, None), [False,True,True,True,True,False,True,False])
chk('OR',  S._eval_group({'logic':'OR','rules':[Cc,D]}, bg, None), [True,True,False,True,True,True,False,True])
nested_g={'logic':'AND','rules':[A,B,{'logic':'OR','rules':[Cc,D]}]}
chk('A and B and (C or D)', S._eval_group(nested_g, bg, None), [False,True,False,True,True,False,False,False])
chk('ATLEAST k=2 of A,B,C', S._eval_group({'logic':'ATLEAST','k':2,'rules':[A,B,Cc]}, bg, None),
    [False,True,True,True,True,True,True,False])

print("== 8. THEN sequence + window ==")
bseq=bars_from(close=[45,55,45,35,60,30])
s1=rule(P(),'gt',C(50)); s2=rule(P(),'lt',C(40))
chk('THEN win=3', S._eval_group({'logic':'THEN','window':3,'rules':[s1,s2]}, bseq, None), [False,False,False,True,False,True])
chk('THEN win=1', S._eval_group({'logic':'THEN','window':1,'rules':[s1,s2]}, bseq, None), [False,False,False,False,False,True])

print("== 9. bounce_up / bounce_down ==")
bbu=bars_from(close=[102,101,100.5,101.0,101.5], l=[101.5,100.8,100.05,100.1,101.0], h=[102.5,101.5,101.0,101.2,101.8])
chk('bounce_up off 100', S._eval_rule(rule(P(),'bounce_up',C(100)), bbu, None), [False,False,False,True,False])
bbd=bars_from(close=[98,99,99.5,99.0,98.5], h=[98.5,99.5,99.9,99.95,98.8], l=[97.5,98.5,99.0,98.5,98.0])
chk('bounce_down off 100', S._eval_rule(rule(P(),'bounce_down',C(100)), bbd, None), [False,False,False,True,False])

print("== 10. rising / falling (slope) ==")
up=bars_from(close=list(np.arange(20)*1.0+10))
dn=bars_from(close=list(100-np.arange(20)*1.0))
chop=bars_from(close=list(10+0.05*np.array([0,1,-1,1,-1,1,-1,1,-1,1,-1,1,-1,1,-1,1,-1,1,-1,1])))
chkval('rising@up',   bool(S._eval_rule(rule(P(),'rising'), up, None)[-1]), True)
chkval('falling@up',  bool(S._eval_rule(rule(P(),'falling'), up, None)[-1]), False)
chkval('falling@dn',  bool(S._eval_rule(rule(P(),'falling'), dn, None)[-1]), True)
chkval('rising@chop', bool(S._eval_rule(rule(P(),'rising'), chop, None)[-1]), False)
chkval('falling@chop',bool(S._eval_rule(rule(P(),'falling'), chop, None)[-1]), False)

print("== 11. _edges (fire once) ==")
chk('edges', S._edges(np.array([False,True,True,False,True])), [False,True,False,False,True])
chk('rolling all', S._rolling(np.array([True,True,False,True,True,True]),2,'all'), [False,True,False,False,True,True])
chk('rolling any', S._rolling(np.array([True,True,False,True,True,True]),2,'any'), [False,True,True,True,True,True])

print("== 12. SL/TP pairing ==")
# long: enter idx1 @100, SL 1% (=99), TP 2% (=102)
bl=bars_from(close=[100,100,100,100,100,100],
             h=[100,100,101,101,100,100],
             l=[100,100,99.5,98.5,100,100])
entry=np.array([False,True,False,False,False,False]); exit_=np.zeros(6,bool)
risk={'sl':{'type':'pct','value':1},'tp':{'type':'pct','value':2}}
tr,_SL,_TP,_OP=S._pair_trades(bl, list(range(6)), entry, exit_, 'long', risk, None)
chkval('long SL n_trades', len(tr), 1)
if tr: chkval('long SL reason', tr[0]['reason'], 'SL'); chkval('long SL xi', tr[0]['xi'], 3); chkval('long SL exit', tr[0]['exit'], 99.0)
# TP-first: high hits 102 at idx2 before any SL
blt=bars_from(close=[100,100,100,100], h=[100,100,102,103], l=[100,100,99.5,99.5])
tr2,_SL,_TP,_OP=S._pair_trades(blt, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'long', risk, None)
chkval('long TP reason', tr2[0]['reason'] if tr2 else None, 'TP')
chkval('long TP exit', tr2[0]['exit'] if tr2 else None, 102.0)
# SL before TP same bar (both hit at idx2) -> SL wins
blst=bars_from(close=[100,100,100,100], h=[100,100,102,102], l=[100,100,98.5,98.5])
tr3,_SL,_TP,_OP=S._pair_trades(blst, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'long', risk, None)
chkval('SL-before-TP same bar', tr3[0]['reason'] if tr3 else None, 'SL')
# short: enter idx1 @100, SL above (101), TP below (98)
bsh=bars_from(close=[100,100,100,100], h=[100,100,101.5,100], l=[100,100,99,98])
trs,_SL,_TP,_OP=S._pair_trades(bsh, list(range(4)), np.array([False,True,False,False]), np.zeros(4,bool), 'short', risk, None)
chkval('short SL reason', trs[0]['reason'] if trs else None, 'SL')
# exit-condition edge (no SL/TP)
bex=bars_from(close=[100,100,100,100,100])
tre,_SL,_TP,_OP=S._pair_trades(bex, list(range(5)), np.array([False,True,False,False,False]), np.array([False,False,False,True,False]), 'long', {}, None)
chkval('exit-rule reason', tre[0]['reason'] if tre else None, 'exit')

print("== 13. NaN operand -> False ==")
bn=bars_from(close=[1,2,3])
chk('nan right -> False', S._apply_op('gt', np.array([1.,2,3]), np.array([np.nan,2,0])), [False,False,True])

print("== 14. sub-line selection (floor R2, dyn sr3, bb upper) ==")
_orig=cs.overlay_arrays
def fake_overlay(bars, ov, ctx, causal=False):
    key=ov.get('key'); n=len(bars)
    if key=='pivots.floor':
        lines=[('P',np.full(n,100.)),('R1',np.full(n,101.)),('R2',np.full(n,102.)),('R3',np.full(n,103.)),
               ('S1',np.full(n,99.)),('S2',np.full(n,98.)),('S3',np.full(n,97.))]
    elif key=='levels.dynamic_sr':
        ml=int((ov.get('params') or {}).get('max_levels',6))
        lines=[(f'sr{i+1}',np.full(n,200.+i)) for i in range(ml)]
    elif key=='volatility.bb':
        lines=[('middle',np.full(n,50.)),('upper',np.full(n,55.)),('lower',np.full(n,45.))]
    else:
        lines=[('v',np.full(n,0.))]
    return None,None,lines
cs.overlay_arrays=fake_overlay
bb2=bars_from(n=3)
chkval('floor R2 val', S._operand_array({'kind':'primitive','key':'pivots.floor','sub':'R2'}, bb2, None)[0], 102.0)
chkval('floor no-sub=first', S._operand_array({'kind':'primitive','key':'pivots.floor'}, bb2, None)[0], 100.0)
chkval('dyn sr3 val', S._operand_array({'kind':'primitive','key':'levels.dynamic_sr','sub':'sr3','params':{'max_levels':6}}, bb2, None)[0], 202.0)
chkval('bb upper val', S._operand_array({'kind':'primitive','key':'volatility.bb','sub':'upper'}, bb2, None)[0], 55.0)
try:
    S._operand_array({'kind':'primitive','key':'pivots.floor','sub':'R9'}, bb2, None)
    chkval('bad sub raises', 'no-raise', 'raise')
except ValueError:
    chkval('bad sub raises', 'raise', 'raise')
# dyn sr with max_levels=3 -> sr3 exists, sr5 must raise
chkval('dyn sr3 (ml=3) ok', S._operand_array({'kind':'primitive','key':'levels.dynamic_sr','sub':'sr3','params':{'max_levels':3}}, bb2, None)[0], 202.0)
try:
    S._operand_array({'kind':'primitive','key':'levels.dynamic_sr','sub':'sr5','params':{'max_levels':3}}, bb2, None)
    chkval('dyn sr5 (ml=3) raises', 'no-raise', 'raise')
except ValueError:
    chkval('dyn sr5 (ml=3) raises', 'raise', 'raise')
cs.overlay_arrays=_orig

print("== 15. _merge_defaults ==")
md=S._merge_defaults('levels.dynamic_sr', {'max_levels':4, 'bogus':99})
chkval('merge keeps max_levels', md.get('max_levels'), 4)
chkval('merge drops bogus', 'bogus' in md, False)
chkval('merge fills default pivot_period', md.get('pivot_period'), 10)

print("\n================  RESULT  ================")
print(f"PASS={PASS}  FAIL={FAIL}")
if FAILS: print("FAILURES:", FAILS)
sys.exit(1 if FAIL else 0)
