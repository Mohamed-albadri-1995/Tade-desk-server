import json, pathlib

def W(fn, s, e):
    return {'kind': 'primitive', 'key': f'levels.window_{fn}', 'source': 'close',
            'params': {'start': s, 'end': e}}

MH, ML = W('high', 930, 1000), W('low', 930, 1000)          # morning window
A, B = W('low', 930, 941), W('low', 941, 1000)              # long invalidation
C, D = W('high', 930, 951), W('high', 951, 1000)            # short invalidation
VWAP = {'kind': 'primitive', 'key': 'vwap.session', 'source': 'close'}
VWAP10 = {'kind': 'primitive', 'key': 'vwap.session', 'source': 'close', 'offset': 10}
CLOSE = {'kind': 'price', 'field': 'close'}

# range_position = (close - morning_low) / (morning_high - morning_low) * 100
RANGE_POS = {'kind': 'expr', 'op': 'mul',
             'a': {'kind': 'expr', 'op': 'div',
                   'a': {'kind': 'expr', 'op': 'sub', 'a': CLOSE, 'b': ML},
                   'b': {'kind': 'expr', 'op': 'sub', 'a': MH, 'b': ML}},
             'b': {'kind': 'const', 'value': 100}}

def build(side):
    L = side == 'long'
    rules = [
        {'left': CLOSE, 'op': 'gt' if L else 'lt', 'right': VWAP},
        {'left': VWAP, 'op': 'gt' if L else 'lt', 'right': VWAP10},
        {'left': RANGE_POS, 'op': 'ge' if L else 'le',
         'right': {'kind': 'const', 'value': 55 if L else 45}},
        # invalidation: LONG rejects if the later low undercut the early low;
        # SHORT rejects if the later high exceeded the early high
        ({'left': B, 'op': 'ge', 'right': A} if L
         else {'left': D, 'op': 'le', 'right': C}),
    ]
    return {
        'name': f'T2 10:00 VWAP Extension ({"Long" if L else "Short"})',
        'side': side,
        '_keep_user_edits': True,
        'entry': {'logic': 'AND', 'rules': rules},
        'exit': {'logic': 'AND', 'rules': []},     # stop / 2R / EOD only
        'risk': {
            'sl': {'type': 'prim', 'anchor': VWAP, 'value': 0.0, 'freeze': True},
            'targets': [{'fraction': 1.0, 'r_multiple': 2.0}],
            'stop_first': True,          # a bar touching both -> stop wins
            'window_start': 1000, 'window_end': 1000,
            'max_entries_per_day': 1,
        },
    }

docs = [build('long'), build('short')]
p = pathlib.Path('chart/seeds/t2_vwap_extension.json')
p.write_text(json.dumps(docs, indent=2) + '\n')
print('wrote', p, [d['name'] for d in docs])
