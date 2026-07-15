"""Audit part 3 — bounce v2 (open-side + close-position guards), status-check
entries/exits, volume composition."""
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
def chkv(name, got, exp):
    global PASS, FAIL
    if got==exp: PASS+=1
    else: FAIL+=1; FAILS.append(name); print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars_from(close, o=None, h=None, l=None, v=None):
    n=len(close)
    idx=pd.date_range('2024-01-02 09:30', periods=n, freq='1min', tz='America/New_York').tz_convert('UTC')
    close=np.array(close,float)
    o=np.array(o,float) if o is not None else close.copy()
    h=np.array(h,float) if h is not None else np.maximum(o,close)
    l=np.array(l,float) if l is not None else np.minimum(o,close)
    v=np.array(v,float) if v is not None else np.full(n,1000.0)
    return pd.DataFrame({'open':o,'high':h,'low':l,'close':close,'volume':v}, index=idx)

P=lambda f='close': {'kind':'price','field':f}
C=lambda x: {'kind':'const','value':x}
def rule(left,op,right=None,**kw):
    r={'left':left,'op':op}
    if right is not None: r['right']=right
    r.update(kw); return r

print("== A. bounce v2: the two attack cases ==")
# ATTACK 1 (your example): bar COMES FROM BELOW the level and closes above.
# prev_close above? make prev bar above so old cond-1 passes; the ATTACK bar
# OPENS below 100, rallies through, closes above -> that's a CROSS, not a bounce.
bx=bars_from(close=[101.0, 100.8, 101.2],
             o    =[101.0, 101.0,  99.5],   # attack bar opens BELOW the level
             h    =[101.5, 101.2, 101.4],
             l    =[100.8, 100.4,  99.4])
chk('slice-through from below = NOT a bounce',
    S._eval_rule(rule(P(),'bounce_up',C(100)), bx, None), [False,False,False])
# same bar but opening ABOVE (a real pullback-touch-recover) = bounce
bg=bars_from(close=[101.0, 100.8, 101.2],
             o    =[101.0, 101.0, 100.9],   # opens above support
             h    =[101.5, 101.2, 101.4],
             l    =[100.8, 100.4, 100.05])  # wick touches 100
chk('real pullback-touch-go = bounce',
    S._eval_rule(rule(P(),'bounce_up',C(100)), bg, None), [False,False,True])

# ATTACK 2 (doji): wick touches, close ticks up 1 cent but sits MID-RANGE.
bd=bars_from(close=[101.0, 100.5, 100.51],
             o    =[101.0, 101.0, 100.6],
             h    =[101.5, 101.0, 101.4],   # big upper wick
             l    =[100.8, 100.3, 100.0])   # touched the level
# close_pos = (100.51-100)/(101.4-100) = 0.36 < 0.6 -> rejected
chk('doji touch = NOT a bounce',
    S._eval_rule(rule(P(),'bounce_up',C(100)), bd, None), [False,False,False])
# same but closing near its high -> bounce
bd2=bars_from(close=[101.0, 100.5, 101.3],
              o    =[101.0, 101.0, 100.6],
              h    =[101.5, 101.0, 101.4],
              l    =[100.8, 100.3, 100.0])
chk('strong close near high = bounce',
    S._eval_rule(rule(P(),'bounce_up',C(100)), bd2, None), [False,False,True])
# bounce_down mirror: attack from above (open above resistance) rejected
bm=bars_from(close=[99.0, 99.2, 98.7],
             o    =[99.0, 99.0, 100.4],     # opened ABOVE resistance 100
             h    =[99.4, 99.5, 100.5],
             l    =[98.7, 98.9, 98.6])
chk('slice-through from above = NOT bounce_down',
    S._eval_rule(rule(P(),'bounce_down',C(100)), bm, None), [False,False,False])
bm2=bars_from(close=[99.0, 99.2, 98.7],
              o    =[99.0, 99.0, 99.3],     # opened below resistance
              h    =[99.4, 99.5, 100.05],   # wick poked the level
              l    =[98.7, 98.9, 98.6])
chk('real rejection at resistance = bounce_down',
    S._eval_rule(rule(P(),'bounce_down',C(100)), bm2, None), [False,False,True])
# custom close_pos param respected (loosen to 0.3 -> doji case passes)
chk('close_pos=0.3 loosens the doji guard',
    S._eval_rule(rule(P(),'bounce_up',C(100),op_params={'close_pos':0.3}), bd, None), [False,False,True])

print("== A2. bounce v4: touch and confirmation on DIFFERENT bars (within) ==")
# The most common real bounce: a weak hammer taps the MA, the NEXT candle
# confirms. Same-bar rules (within=1) rightly reject the hammer alone — but
# the pair IS a valid bounce, and within=3 must see it.
b2b=bars_from(close=[101.0, 100.30, 101.10],
              o    =[101.0, 100.90, 100.40],
              h    =[101.5, 101.00, 101.20],
              l    =[100.8, 100.05, 100.35])  # bar1 taps 100, closes weak (pos .26)
chk('within=1 (default): weak-touch-then-confirm NOT seen (old behavior)',
    S._eval_rule(rule(P(),'bounce_up',C(100)), b2b, None), [False,False,False])
chk('within=3: fires on the confirmation bar',
    S._eval_rule(rule(P(),'bounce_up',C(100),op_params={'within':3}), b2b, None),
    [False,False,True])
# a decisive CLOSE through the level between touch and confirm = breakdown,
# and the later reclaim is a CROSS — never a bounce, whatever the window
bbrk=bars_from(close=[101.0,  99.50, 101.10],
               o    =[101.0, 100.90, 100.20],
               h    =[101.5, 101.00, 101.20],
               l    =[100.8,  99.40, 100.10])
chk('breakdown close between touch and confirm kills it (within=3)',
    S._eval_rule(rule(P(),'bounce_up',C(100),op_params={'within':3}), bbrk, None),
    [False,False,False])
# window boundary: touch at bar1, drift bar2, confirm bar3 -> needs within>=3
b3b=bars_from(close=[101.0, 100.30, 100.25, 101.10],
              o    =[101.0, 100.90, 100.30, 100.30],
              h    =[101.5, 101.00, 100.40, 101.20],
              l    =[100.8, 100.05, 100.20, 100.28])
chk('touch->drift->confirm inside within=3',
    S._eval_rule(rule(P(),'bounce_up',C(100),op_params={'within':3}), b3b, None),
    [False,False,False,True])
chk('same shape outside within=2 window: no fire',
    S._eval_rule(rule(P(),'bounce_up',C(100),op_params={'within':2}), b3b, None),
    [False,False,False,False])
# bounce_down mirror: weak poke at resistance, next bar confirms down
b2d=bars_from(close=[99.0, 99.70, 98.80],
              o    =[99.0, 99.20, 99.50],
              h    =[99.4, 100.10, 99.60],
              l    =[98.7, 99.10, 98.70])
chk('bounce_down within=3: poke then confirm-down fires',
    S._eval_rule(rule(P(),'bounce_down',C(100),op_params={'within':3}), b2d, None),
    [False,False,True])
chk('bounce_down within=1: same shape not seen (old behavior)',
    S._eval_rule(rule(P(),'bounce_down',C(100)), b2d, None), [False,False,False])

print("== B. STATUS entries/exits in trade pairing ==")
n=8
b=bars_from(close=[100]*n, h=[100.2]*n, l=[99.8]*n)
# exit condition TRUE THE WHOLE TIME (no flip after entry) — used to never exit
entry=np.array([False,True,False,False,False,False,False,False])
exit_all=np.ones(n,bool)
tr,_SL,_TP,_OP=S._pair_trades(b, list(range(n)), entry, exit_all, 'long', {}, None)
chkv('always-true exit closes next bar', (tr[0]['xi'], tr[0]['reason']) if tr else None, (2,'exit'))
# re-entry while the entry STATUS is still on, after an SL stop-out
b2=bars_from(close=[100,100,100,100,100,100],
             h=[100.2]*6,
             l=[99.8,99.8,98.5,99.8,98.5,99.8])   # SL 1% (=99) hit at idx2 and idx4
entry_status=np.array([False,True,True,True,True,True])   # setup stays valid
risk={'sl':{'type':'pct','value':1}}
# EDGE default: a persistent true-run is ONE setup → one entry (no nonsense
# re-entry after the stop-out while the same condition still holds).
tr2,_SL,_TP,_OP=S._pair_trades(b2, list(range(6)), entry_status, np.zeros(6,bool), 'long', risk, None)
chkv('edge default: persistent run enters ONCE', [(t['ei'],t['xi'],t['reason']) for t in tr2],
     [(1,2,'SL')])
# STATUS mode (opt-in) restores the old any-true-bar re-entry
tr2s,_,_,_=S._pair_trades(b2, list(range(6)), entry_status, np.zeros(6,bool), 'long', risk, None, entry_mode='status')
chkv('status mode: re-enters while it holds', [(t['ei'],t['xi'],t['reason']) for t in tr2s],
     [(1,2,'SL'),(3,4,'SL')])
# a spiky mask (each true bar preceded by false) = a NEW run each time → re-enters
entry_spiky=np.array([False,True,False,True,False,True])
tr3,_SL,_TP,_OP=S._pair_trades(b2, list(range(6)), entry_spiky, np.zeros(6,bool), 'long', risk, None)
chkv('spiky mask: each edge is a new setup', len(tr3)>=2, True)
# one-bar signal → single trade
entry_once=np.array([False,True,False,False,False,False])
tr4,_,_,_=S._pair_trades(b2, list(range(6)), entry_once, np.zeros(6,bool), 'long', risk, None)
chkv('one-shot signal: single trade', len(tr4), 1)

print("== C. volume composition (no new primitives needed) ==")
# volume > sma(volume, 3): rel volume spike via existing pieces
bv=bars_from(close=[100]*6, v=[1000,1000,1000,1000,3000,1000])
r=rule(P('volume'),'gt',{'kind':'primitive','key':'ma.sma','source':'volume','params':{'length':3}})
got=S._eval_rule(r, bv, None)
chk('volume > sma(volume,3) spikes at idx4', got, [False,False,False,False,True,False])
# volume vs volume[1] (rising volume) via offset
r2=rule(P('volume'),'gt',{'kind':'price','field':'volume','offset':1})
chk('volume > volume[1]', S._eval_rule(r2, bv, None), [False,False,False,False,True,False])

print("\n================  RESULT (part 3)  ================")
print(f"PASS={PASS}  FAIL={FAIL}")
if FAILS: print("FAILURES:", FAILS)
sys.exit(1 if FAIL else 0)
