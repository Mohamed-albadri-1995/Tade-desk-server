"""Will the broker let this account short the name?

WHY A BACKTEST HAS TO ASK. Backtest #354, 2026-09-08 to 09-14, twelve trades:

    net profit                   +$1,345.43
    XE, short, its largest win   +$1,408.60
    without XE                      -$63.17

Live, the same signal came back

    alpaca1: FAILED — asset "XE" cannot be sold short

so the entire profit of that run is one trade the broker refuses to place. The
same thing had already happened to STKH and LBGJ on 2026-08-14 and to CAPR
before that. Most of what these screeners find is a small cap with no borrow,
so for a short book this is the common case, not the edge one.

WHAT THIS CAN AND CANNOT KNOW, said plainly because it decides how the answer
may be used. Alpaca reports `shortable` for an asset AS IT IS NOW. There is no
history: nothing here can say whether XE was borrowable on the 9th. So this is
TODAY'S borrow flag applied to a past day — a good approximation of a standing
fact (a name that cannot be borrowed today generally could not last week
either) and still an approximation. Every caller must label it as one.

AN UNANSWERABLE CHECK IS NOT A REFUSAL. If Alpaca cannot be reached, `shortable`
is None and the trade stands. Dropping trades because a lookup timed out would
turn a network blip into a strategy result, which is a worse lie than the one
this fixes. The live desk makes the same choice in the same words — see
checkShortable in src/alpaca/client.js, which warns and sends.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request

# PAPER BY DEFAULT, like every other credential path here: the failure of
# guessing wrong in that direction is a query against a simulator, and in the
# other it is a query against real money.
_DEFAULT_BASE = 'https://paper-api.alpaca.markets'

# Asked once per symbol per process. Borrow status changes across days, not
# across the seconds of one backtest, and a run over twenty names must not
# become twenty round trips per day tested.
_CACHE: dict[str, dict] = {}
_LOCK = threading.Lock()


def _base() -> str:
    return (os.environ.get('APCA_API_BASE_URL') or _DEFAULT_BASE).rstrip('/')


def _headers() -> dict | None:
    key = os.environ.get('APCA_API_KEY_ID')
    sec = os.environ.get('APCA_API_SECRET_KEY')
    if not key or not sec:
        return None
    return {'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': sec}


def _fetch(symbol: str, timeout: float) -> dict:
    head = _headers()
    if head is None:
        return {'shortable': None,
                'reason': 'no Alpaca credentials here — borrow was not checked'}
    url = f'{_base()}/v2/assets/{symbol.upper()}'
    req = urllib.request.Request(url, headers=head)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            a = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        # A SYMBOL ALPACA DOES NOT LIST is a real answer: it cannot be traded
        # there at all, so it certainly cannot be shorted.
        if e.code == 404:
            return {'shortable': False, 'easy': False,
                    'reason': f'{symbol.upper()} is not an asset at this broker'}
        return {'shortable': None, 'reason': f'the broker answered {e.code}'}
    except Exception as e:                            # noqa: BLE001
        return {'shortable': None, 'reason': f'could not ask the broker: {e}'}

    ok = a.get('shortable') is True
    return {
        'shortable': ok,
        'easy': a.get('easy_to_borrow') is True,
        'reason': None if ok
        else f'{symbol.upper()} cannot be sold short at this broker',
    }


def shortable(symbol: str, timeout: float = 6.0) -> dict:
    """`{shortable: True|False|None, easy: bool, reason: str|None}`.

    None means the question could NOT be asked, which is deliberately not the
    same as False. "The broker will not short this" and "nobody asked the
    broker" are opposite instructions to a backtest.
    """
    sym = str(symbol or '').upper()
    if not sym:
        return {'shortable': None, 'reason': 'no symbol'}
    with _LOCK:
        hit = _CACHE.get(sym)
    if hit is not None:
        return dict(hit)
    got = _fetch(sym, timeout)
    with _LOCK:
        _CACHE[sym] = got
    return dict(got)


def forget() -> None:
    """Drop the per-process cache. For tests, and for a long-lived server that
    wants a fresh reading on a new day."""
    with _LOCK:
        _CACHE.clear()
