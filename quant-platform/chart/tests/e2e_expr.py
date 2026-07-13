"""E2E: expr with atr_daily inside, through the REAL evaluate()/test_condition
path (required_days -> prepare_bars -> overlay_arrays -> compute_tf fetch)."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.strategy as S

rng=np.random.default_rng(3)
class StubLoader:
    name='stub'
    def load(self, symbol, tf, start, end):
        if tf=='1d':
            idx=pd.date_range(end - pd.Timedelta(days=90), end, freq='1D', tz='UTC')
            n=len(idx); base=100+np.cumsum(rng.normal(0,1,n))
            return pd.DataFrame({'open':base,'high':base+2,'low':base-2,'close':base+rng.normal(0,.5,n),'volume':1e6}, index=idx)
        # 1m bars, only within [start,end]
        idx=pd.date_range(start, end, freq='1min', tz='UTC')[:5000]
        n=len(idx); base=100+np.cumsum(rng.normal(0,0.05,n))
        o=base+rng.normal(0,0.02,n); c=base+rng.normal(0,0.05,n)
        return pd.DataFrame({'open':o,'high':np.maximum(o,c)+0.03,'low':np.minimum(o,c)-0.03,'close':c,'volume':1000}, index=idx)

cs._LOADERS['stub']=StubLoader()

# the user's exact construction: Price close - Price open  >  atr_daily / 100
expr_left={'kind':'expr','op':'sub','a':{'kind':'price','field':'close'},'b':{'kind':'price','field':'open'}}
expr_right={'kind':'expr','op':'div','a':{'kind':'primitive','key':'volatility.atr_daily','source':'close','params':{'length':14}},'b':{'kind':'const','value':100}}
strat={'name':'t','side':'long',
       'entry':{'logic':'AND','rules':[{'left':expr_left,'op':'gt','right':expr_right}]},
       'exit':{'logic':'AND','rules':[{'left':expr_left,'op':'lt','right':expr_right}]}}
try:
    r=S.evaluate(strat,'SPY','1m',3,feed='stub',view='all')
    print('evaluate ok:', r['ok'], '| bars:', r['bars'], '| entries:', len(r['entries']), '| entry_now:', r['entry_now'])
    assert r['bars']>0 and len(r['entries'])>0, 'expected some entries'
    print('PASS: close-open > atr_daily/100 fires', len(r['entries']), 'times over', r['bars'], 'bars')
except Exception as e:
    import traceback; traceback.print_exc()
    print('FAIL:', e)

# also the single-rule tester path (the 🔍 button)
try:
    t=S.test_condition({'left':expr_left,'op':'gt','right':expr_right},'SPY','1m',3,feed='stub',view='all')
    print('test_condition ok:', t['ok'], '| true on', t['true'],'/',t['bars'],'bars | left_now:',t['left_now'],'| right_now:',t['right_now'])
except Exception as e:
    import traceback; traceback.print_exc()

# and cross_above + for_bars through evaluate (vwap.session as the level)
strat2={'name':'t2','side':'long',
        'entry':{'logic':'AND','rules':[{'left':{'kind':'price','field':'close'},'op':'cross_above',
                 'right':{'kind':'primitive','key':'vwap.session','source':'close','params':{}},'for_bars':3}]},
        'exit':{'logic':'AND','rules':[]}}
try:
    r2=S.evaluate(strat2,'SPY','1m',3,feed='stub',view='all')
    print('cross+hold3 over session vwap: entries =', len(r2['entries']), '(should be >0 and less than plain cross)')
    strat2['entry']['rules'][0].pop('for_bars')
    r3=S.evaluate(strat2,'SPY','1m',3,feed='stub',view='all')
    print('plain cross entries =', len(r3['entries']))
    assert len(r2['entries'])>0 and len(r2['entries'])<=len(r3['entries'])
    print('PASS: cross+hold fires, and less often than plain cross')
except Exception as e:
    import traceback; traceback.print_exc()
