"""Audit part 7 — Trade operand (P&L / bars-held / entry) + expr-anchored SL.
Covers the user's two examples verbatim."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS=0; FAIL=0
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
T=lambda f: {'kind':'trade','field':f}
def rule(left,op,right=None,**kw):
    r={'left':left,'op':op}
    if right is not None: r['right']=right
    r.update(kw); return r

print("== 1. P&L-based exit (the 'or 1%' leg) ==")
# long entry idx1 @100; closes 100,100,99.6,98.9 -> pnl -0.4% then -1.1%
b=bars_from(close=[100,100,99.6,98.9])
xg={'logic':'AND','rules':[rule(T('pnl_pct'),'lt',C(-1))]}
tr,_,_,op=S._pair_trades(b, list(range(4)), np.array([False,True,False,False]),
                          None, 'long', {}, None, exit_group=xg)
chkv('pnl<-1% exits at idx3', (tr[0]['xi'],tr[0]['reason']) if tr else None, (3,'exit'))
chkv('exit at close 98.9', round(tr[0]['exit'],2) if tr else None, 98.9)
# short: price RISES -> pnl negative -> same rule protects a short
bs=bars_from(close=[100,100,100.4,101.1])
trs,_,_,_=S._pair_trades(bs, list(range(4)), np.array([False,True,False,False]),
                          None, 'short', {}, None, exit_group=xg)
chkv('short pnl<-1% exits at idx3', (trs[0]['xi'],trs[0]['reason']) if trs else None, (3,'exit'))

print("== 2. time stop: bars in trade >= 3 ==")
b2=bars_from(close=[100]*6)
xg2={'logic':'AND','rules':[rule(T('bars'),'ge',C(3))]}
tr2,_,_,_=S._pair_trades(b2, list(range(6)), np.array([False,True,False,False,False,False]),
                          None, 'long', {}, None, exit_group=xg2)
chkv('time stop exits 3 bars after entry', tr2[0]['xi'] if tr2 else None, 4)

print("== 3. EACH trade sees its OWN entry (re-entry correctness) ==")
# entry status held; trade1 enters @1 (100), exits pnl<-1 @3 (98.5);
# trade2 re-enters @4 (98.5) -> its -1% is 97.5, hit @6 (97.3)
b3=bars_from(close=[100,100,99.5,98.5,98.5,98.0,97.3])
ent=np.array([False,True,True,True,True,True,True])
# status mode → re-enter while the setup holds, so we can verify each trade
# computes its Trade-operand P&L off its OWN entry baseline
tr3,_,_,_=S._pair_trades(b3, list(range(7)), ent, None, 'long', {}, None, exit_group=xg, entry_mode='status')
chkv('two trades, own baselines', [(t['ei'],t['xi']) for t in tr3], [(1,3),(4,6)])

print("== 4. YOUR EXAMPLE 1: exit if price 2*ATR below MA  OR  down 1% ==")
# synthesize: ma=const 100, atr=const 0.4 -> level leg: close < 100-0.8=99.2
ma_minus_2atr={'kind':'expr','op':'sub','a':C(100),
               'b':{'kind':'expr','op':'mul','a':C(0.4),'b':C(2)}}
ex1={'logic':'OR','rules':[
    rule(P('close'),'lt', ma_minus_2atr),          # leg A: 2 ATR below MA
    rule(T('pnl_pct'),'le', C(-1)),                # leg B: down 1% from entry
]}
# case A-first: entry @1 (100); close 99.1 @2 -> leg A (99.1<99.2) fires
# before pnl leg (-0.9% not <=-1)
bA=bars_from(close=[100,100,99.1,99.0])
trA,_,_,_=S._pair_trades(bA, list(range(4)), np.array([False,True,False,False]),
                          None, 'long', {}, None, exit_group=ex1)
chkv('leg A (level) fires first', trA[0]['xi'] if trA else None, 2)
# case B-first: entry @1 (99.4); close 98.3 @2 -> pnl -1.1% fires while
# 98.3<99.2 also true — same bar either way; now entry @1(100), close 98.9:
# leg A false (98.9<99.2 true!)... choose entry 100.5: -1% = 99.49; close 99.3
# -> pnl -1.19% TRUE, leg A (99.3<99.2) FALSE -> only pnl leg fired
bB=bars_from(close=[100.5,100.5,99.3,99.3])
trB,_,_,_=S._pair_trades(bB, list(range(4)), np.array([False,True,False,False]),
                          None, 'long', {}, None, exit_group=ex1)
chkv('leg B (pnl) fires alone', trB[0]['xi'] if trB else None, 2)

print("== 5. YOUR EXAMPLE 1 as INTRABAR trailing stop: SL @ expr(MA - 2*ATR) ==")
# anchor = expr(open - 0.8) stands in for ma-2atr; entry @1 close 100,
# lows: 99.5,99.5,99.1 -> level = open-0.8 = 99.2 flat; low 99.1 <= 99.2 @3 -> SL
b5=bars_from(close=[100,100,100,100], o=[100,100,100,100], l=[99.5,99.5,99.5,99.1], h=[100.2]*4)
risk={'sl':{'type':'prim','value':0,'anchor':{'kind':'expr','op':'sub','a':P('open'),
      'b':{'kind':'expr','op':'mul','a':C(0.4),'b':C(2)}}}}
tr5,slv5,_,_=S._pair_trades(b5, list(range(4)), np.array([False,True,False,False]),
                             np.zeros(4,bool), 'long', risk, None)
chkv('expr-anchored SL fires intrabar at level', (tr5[0]['xi'],tr5[0]['reason'],round(tr5[0]['exit'],2)) if tr5 else None, (3,'SL',99.2))

print("== 6. YOUR EXAMPLE 2 composes (all existing pieces) ==")
# break below MA(const 100) OR [exhaustion candle AND moved >2 dailyATR] OR above R3(const 106)
exhaustion={'kind':'expr','op':'div',
            'a':{'kind':'expr','op':'sub','a':P('high'),'b':P('close')},
            'b':{'kind':'expr','op':'sub','a':P('high'),'b':P('low')}}  # upper-wick fraction
moved={'kind':'expr','op':'div','a':{'kind':'expr','op':'sub','a':P('close'),'b':P('open')},'b':C(0.5)}
ex2={'logic':'OR','rules':[
    rule(P('close'),'cross_below',C(100)),
    {'logic':'AND','rules':[rule(exhaustion,'gt',C(0.6)), rule(moved,'gt',C(2))]},
    rule(P('close'),'gt',C(106)),
]}
# bar2: close 107 (>106) -> exits via R3 leg
b6=bars_from(close=[102,103,107,107], o=[102,103,103,107], h=[102.5,103.5,108,107.5], l=[101.5,102.5,102.8,106.5])
tr6,_,_,_=S._pair_trades(b6, list(range(4)), np.array([False,True,False,False]),
                          S._eval_group(ex2,b6,None), 'long', {}, None)
chkv('example-2 composition exits via R3 leg', tr6[0]['xi'] if tr6 else None, 2)

print("== 7. guards ==")
try:
    S._eval_group({'logic':'AND','rules':[rule(T('pnl_pct'),'lt',C(-1))]}, bars_from(close=[1,2]), None)
    chkv('trade in entry raises', 'no', 'raise')
except ValueError:
    chkv('trade in entry raises', 'raise', 'raise')
r=S.test_condition({'left':T('pnl_pct'),'op':'lt','right':C(-1)}, 'SPY','1m',1)
chkv('tester friendly error', r['ok'], False)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
