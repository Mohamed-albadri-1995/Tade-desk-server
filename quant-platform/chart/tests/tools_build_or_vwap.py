"""Build the Opening-Range + session-VWAP setup (long and short) as seeds."""
import json, pathlib

OR_HI = {'kind': 'primitive', 'key': 'levels.window_high', 'source': 'close',
         'params': {'start': 930, 'end': 935}}
OR_LO = {'kind': 'primitive', 'key': 'levels.window_low', 'source': 'close',
         'params': {'start': 930, 'end': 935}}
VWAP = {'kind': 'primitive', 'key': 'vwap.session', 'source': 'close'}
VWAP_BACK = {'kind': 'primitive', 'key': 'vwap.session', 'source': 'close', 'offset': 3}
CLOSE = {'kind': 'price', 'field': 'close'}
ATR = {'kind': 'primitive', 'key': 'volatility.atr', 'source': 'close',
       'params': {'length': 14}}

# midpoint = ORL + (ORH - ORL) / 2
OR_RANGE = {'kind': 'expr', 'op': 'sub', 'a': OR_HI, 'b': OR_LO}
MID = {'kind': 'expr', 'op': 'add', 'a': OR_LO,
       'b': {'kind': 'expr', 'op': 'div', 'a': OR_RANGE,
             'b': {'kind': 'const', 'value': 2}}}
# where in the OR did the 09:34 bar close?  (close - ORL) / (ORH - ORL)
POS_IN_OR = {'kind': 'expr', 'op': 'div',
             'a': {'kind': 'expr', 'op': 'sub', 'a': CLOSE, 'b': OR_LO},
             'b': OR_RANGE}
HALF_ATR = {'kind': 'expr', 'op': 'mul', 'a': ATR, 'b': {'kind': 'const', 'value': 0.5}}


def build(side):
    long_ = side == 'long'
    rules = [
        # 1. price on the right side of session VWAP
        {'left': CLOSE, 'op': 'gt' if long_ else 'lt', 'right': VWAP},
        # 2. session VWAP turning up / down. NOT the 10-bar lookback in the
        #    brief: at the 09:34 close the session VWAP is only five bars old
        #    (it is RTH-only and resets at 09:30), so ten bars back lands in
        #    premarket where it is NaN and the rule could never be true. 3 bars
        #    is the longest slope that is reliably inside the opening range.
        {'left': VWAP, 'op': 'gt' if long_ else 'lt', 'right': VWAP_BACK},
        # 3. the 09:34 candle closed in the top / bottom 45% of the OR
        {'left': POS_IN_OR, 'op': 'ge' if long_ else 'le',
         'right': {'kind': 'const', 'value': 0.55 if long_ else 0.45}},
        # 4. the stop must be at least ~0.5 ATR away — the "opening five
        #    minutes were unusually quiet, skip it" branch of the brief.
        {'left': {'kind': 'expr', 'op': 'sub',
                  'a': CLOSE if long_ else MID, 'b': MID if long_ else CLOSE},
         'op': 'ge', 'right': HALF_ATR},
    ]
    return {
        'name': f'OR + VWAP 09:35 ({"Long" if long_ else "Short"})',
        'side': side,
        '_keep_user_edits': True,
        'entry': {'logic': 'AND', 'rules': rules},
        # trail the RUNNER behind session VWAP — armed only once the 2R half
        # has banked, which is what "trail the balance" means.
        'exit': {'logic': 'AND', 'scope': 'runner', 'rules': [
            {'left': CLOSE, 'op': 'cross_below' if long_ else 'cross_above',
             'right': VWAP}]},
        'risk': {
            'sl': {'type': 'prim', 'anchor': MID, 'value': 0.0, 'freeze': True},
            'targets': [{'fraction': 0.5, 'r_multiple': 2.0}],
            # signal fires at the 09:34 CLOSE, fill is the 09:35 OPEN, and the
            # engine checks the window on the FILL bar — so 935/935.
            'window_start': 935, 'window_end': 935,
            'max_entries_per_day': 1,
        },
    }


docs = [build('long'), build('short')]
p = pathlib.Path('chart/seeds/or_vwap.json')
p.write_text(json.dumps(docs, indent=2) + '\n')
print(f'wrote {p} — {[d["name"] for d in docs]}')
