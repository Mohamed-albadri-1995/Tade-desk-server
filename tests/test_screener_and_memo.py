"""Screener r0 parsing (Market Tab spec shape) and primitive memoization."""

from datetime import datetime

from app.services.market_proxy import MarketDataProxy
from app.services.screener_data import REGISTRY_PATHS, _parse_record


def test_parse_real_r0_row():
    """The shape the screener tool actually serves at /api/registry/today."""
    r0 = {
        "id": "abc",
        "ticker": "SDOT",
        "date": "2026-07-06",
        "liveNow": True,
        "screenerKeys": ["premarket"],
        "stock": {
            "price": 21.45,
            "sector": "Consumer Durables",
            "rvol": 52.2,
            "gapPct": 18.3,
            "vwap": 18.0,
        },
        "context": {
            "regime": "Correction (bull intact)",
            "secBias": "BULLISH",
            "secScore": 37,
            "secHot": True,
            "themes": ["RESTAURANTS"],
        },
        "catalyst": {"label": "M&A", "sentiment": "Bull"},
        "_score": 51,
        "inShortlist": False,
    }
    ctx = _parse_record(r0)
    assert ctx.stock == "SDOT"
    assert ctx.regime == "Correction (bull intact)"
    assert ctx.secBias == "BULLISH"
    assert ctx.secHot is True
    assert ctx.secScore == 37
    assert ctx.sector == "Consumer Durables"
    assert ctx.themes == ["RESTAURANTS"]
    assert ctx.score == 51  # from _score, not stock fields
    assert ctx.rvol == 52.2
    assert ctx.gapPct == 18.3
    assert ctx.catalyst == "M&A"  # label extracted from the catalyst object
    assert ctx.raw is r0  # full record kept for the gate snapshot


def test_parse_flat_legacy_row_still_works():
    ctx = _parse_record({"ticker": "nvda", "regime": "BULL", "score": 70})
    assert ctx.stock == "NVDA"
    assert ctx.regime == "BULL"
    assert ctx.score == 70


def test_registry_today_is_tried_first():
    assert REGISTRY_PATHS[0] == "/api/registry/today"


def test_primitive_memoization(bars):
    calls = {"n": 0}
    import qp

    original = qp.REGISTRY["sma"].fn

    def counting(bars_, **params):
        calls["n"] += 1
        return original(bars_, **params)

    cache = {"AAPL": {"bars": bars, "price": bars[-1]["close"], "timestamp": datetime(2026, 7, 6, 12, 0)}}
    proxy = MarketDataProxy(cache)
    object.__setattr__(qp.REGISTRY["sma"], "__dict__", dict(qp.REGISTRY["sma"].__dict__))  # frozen dataclass workaround not needed; patch registry directly
    qp.REGISTRY["sma"].__dict__["fn"] = counting
    try:
        first = proxy.sma("AAPL", length=9)
        second = proxy.sma("AAPL", length=9)
        assert first == second
        assert calls["n"] == 1  # second call served from the memo

        proxy.sma("AAPL", length=5)
        assert calls["n"] == 2  # different params -> recomputed

        # New bar generation invalidates the memo.
        cache["AAPL"]["timestamp"] = datetime(2026, 7, 6, 12, 0, 5)
        proxy.sma("AAPL", length=9)
        assert calls["n"] == 3
    finally:
        qp.REGISTRY["sma"].__dict__["fn"] = original


def test_memo_returns_copies_for_containers(bars):
    cache = {"AAPL": {"bars": bars, "price": 1.0, "timestamp": datetime(2026, 7, 6)}}
    proxy = MarketDataProxy(cache)
    first = proxy.bollinger("AAPL", length=20)
    first["upper"] = -999.0  # a script mutating its result...
    second = proxy.bollinger("AAPL", length=20)
    assert second["upper"] != -999.0  # ...must not poison the memo
