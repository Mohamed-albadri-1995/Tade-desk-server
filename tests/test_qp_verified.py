"""Integration test against the VERIFIED quant-platform qp library.

Run standalone with the library available (it shadows the placeholder
for the whole process, so it must not run inside the normal suite):

    QP_PATH=/path/to/quant-platform QP_VERIFIED_TEST=1 \
        python -m pytest tests/test_qp_verified.py -q

Expected values come from INTEGRATION.md §6 (seed 7, verified output
``bars=100  sma9=98.6578  atr14=0.2018``).
"""

import os
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.skipif(
    not os.getenv("QP_VERIFIED_TEST"),
    reason="verified-qp integration test (set QP_VERIFIED_TEST=1 and QP_PATH)",
)


def make_doc_rows():
    """The exact synthetic bars from INTEGRATION.md §6 (seed 7)."""
    import numpy as np

    rng = np.random.default_rng(7)
    t0 = datetime(2026, 7, 6, 13, 30, tzinfo=timezone.utc)
    rows, price = [], 100.0
    for i in range(100):
        price += rng.normal(0, 0.05)
        rows.append(
            {
                "timestamp": (t0 + timedelta(minutes=i)).isoformat(),
                "open": round(price, 2),
                "high": round(price + 0.10, 2),
                "low": round(price - 0.10, 2),
                "close": round(price + rng.normal(0, 0.02), 2),
                "volume": int(rng.uniform(500, 5000)),
            }
        )
    return rows


def test_verified_library_loaded():
    from app import qp_loader

    assert qp_loader.VERIFIED, "verified qp did not load — check QP_PATH"
    import qp

    approved = qp.approved_primitives()
    assert len(approved) >= 1
    assert all(hasattr(m, "fn") and hasattr(m, "outputs") for m in approved.values())


def test_proxy_routes_to_verified_primitives():
    import qp
    from app.services.market_proxy import MarketDataProxy

    rows = make_doc_rows()
    cache = {"TEST": {"bars": rows, "price": rows[-1]["close"], "timestamp": "g1"}}
    proxy = MarketDataProxy(cache)

    sma9 = proxy.sma("TEST", length=9)
    assert sma9 == pytest.approx(98.6578, abs=0.0001)  # INTEGRATION.md verified output

    # atr: check the doc's value against the registry directly; through the
    # proxy it must be gated by its live approval status.
    from app.services.market_proxy import _bars_from_dicts, _latest

    atr_direct = _latest(qp.REGISTRY["volatility.atr"].fn(_bars_from_dicts(rows), length=14))
    assert atr_direct == pytest.approx(0.2018, abs=0.0001)
    if qp.is_approved("volatility.atr"):
        assert proxy.atr("TEST", length=14) == pytest.approx(0.2018, abs=0.0001)
    else:
        with pytest.raises(AttributeError, match="no approved primitive"):
            proxy.atr("TEST", length=14)

    # Memo hit returns the identical value.
    assert proxy.sma("TEST", length=9) == sma9


def test_unapproved_primitives_are_not_reachable():
    import qp
    from app.services.market_proxy import MarketDataProxy

    approved_names = {m.name for m in qp.approved_primitives().values()}
    all_names = {m.name for m in qp.REGISTRY.values()}
    unapproved = sorted(all_names - approved_names)
    if not unapproved:
        pytest.skip("everything is approved — nothing to verify exclusion with")

    proxy = MarketDataProxy({})
    with pytest.raises(AttributeError, match="no approved primitive"):
        getattr(proxy, unapproved[0])


def test_dict_output_primitive_returns_dict_of_floats():
    import qp
    from app.services.market_proxy import MarketDataProxy

    multi = [
        m for m in qp.approved_primitives().values()
        if m.outputs != ("value",) and m.name != "dynamic_sr"
    ]
    if not multi:
        pytest.skip("no approved multi-output primitive yet")
    meta = multi[0]
    rows = make_doc_rows()
    proxy = MarketDataProxy({"TEST": {"bars": rows, "price": 1.0, "timestamp": "g1"}})
    out = getattr(proxy, meta.name)("TEST")
    assert isinstance(out, dict)
    assert set(out) == set(meta.outputs)
    assert all(v is None or isinstance(v, float) for v in out.values())
