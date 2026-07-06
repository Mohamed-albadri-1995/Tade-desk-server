"""Golden-number tests for exit enrichment and the analytics service."""

from datetime import datetime, timedelta

import pytest

from app.models import JournalModel
from app.services import analytics
from app.services.exit_enrichment import compute_exit_enrichment


def make_trade(i, pnl, side="long", r=None, entry=100.0, shares=10, hold=30.0,
               grade="B", setup_id=1, capture=None, conditions=None):
    t0 = datetime(2026, 7, 1, 14, 0) + timedelta(hours=i)  # 10:00 ET
    return JournalModel(
        id=i, stock="TEST", setup_id=setup_id, signal_side=side, status="closed",
        entry_signal_time=t0, entry_price=entry, entry_sl_price=entry - 2 if side == "long" else entry + 2,
        entry_tp_price=None, entry_shares=shares, entry_grade=grade,
        entry_default_results=conditions or {}, entry_additional_results={},
        entry_mandatory_results={}, entry_factors={}, entry_gate_allowed=True,
        exit_time=t0 + timedelta(minutes=hold), exit_price=entry + pnl / shares,
        exit_pnl=float(pnl), r_multiple=r, capture_pct=capture, hold_minutes=hold,
    )


@pytest.fixture()
def trades():
    # 3 wins (+100, +200, +300), 2 losses (-100, -100) => net +400
    return [
        make_trade(1, 100, r=0.5, conditions={"c1": True}),
        make_trade(2, 200, r=1.0, conditions={"c1": True}),
        make_trade(3, 300, r=1.5, conditions={"c1": False}),
        make_trade(4, -100, r=-0.5, conditions={"c1": True}),
        make_trade(5, -100, r=-0.5, conditions={"c1": False}),
    ]


def test_account_metrics_golden(trades):
    m = analytics.account_metrics(trades)
    assert m["closed"] == 5
    assert m["net_pnl"] == 400.0
    assert m["win_rate"] == 60.0
    assert m["profit_factor"] == 3.0  # 600 / 200
    assert m["expectancy"] == 80.0  # 400 / 5
    assert m["expectancy_r"] == 0.4  # mean(0.5,1,1.5,-0.5,-0.5)
    assert m["avg_win"] == 200.0
    assert m["avg_loss"] == -100.0
    assert m["payoff"] == 2.0
    assert m["max_win_streak"] == 3
    assert m["max_loss_streak"] == 2


def test_equity_series_drawdown(trades):
    es = analytics.equity_series(trades)
    # equity path: 100, 300, 600, 500, 400 -> max dd = 200 from peak 600
    assert [p["equity"] for p in es["points"]] == [100.0, 300.0, 600.0, 500.0, 400.0]
    assert es["max_drawdown"] == 200.0
    assert es["max_drawdown_pct"] == pytest.approx(33.33, abs=0.01)


def test_breakdown_by_condition(trades):
    rows = analytics.breakdown(trades, "condition")
    buckets = {r["bucket"]: r["metrics"] for r in rows}
    assert buckets["c1 ✓"]["closed"] == 3  # trades 1,2,4
    assert buckets["c1 ✓"]["net_pnl"] == 200.0
    assert buckets["c1 ✗"]["closed"] == 2  # trades 3,5
    assert buckets["c1 ✗"]["net_pnl"] == 200.0


def test_breakdown_by_hour_and_session(trades):
    hours = {r["bucket"] for r in analytics.breakdown(trades, "hour")}
    assert any("ET" in h for h in hours)
    sessions = {r["bucket"] for r in analytics.breakdown(trades, "session")}
    assert sessions <= {"premarket", "open", "morning", "midday", "power_hour", "afterhours", "unknown"}


def test_calendar(trades):
    cal = analytics.calendar(trades, month="2026-07")
    total = sum(d["pnl"] for d in cal["days"].values())
    assert total == 400.0


def test_risk_histogram(trades):
    rv = analytics.risk_view(trades)
    hist = {b["bucket"]: b["count"] for b in rv["r_histogram"]}
    assert hist["-1..0R"] == 2
    assert hist["0..1R"] == 1
    assert hist["1..2R"] == 2


def test_exit_enrichment_math():
    entry = JournalModel(
        stock="TEST", setup_id=1, signal_side="long", status="closed",
        entry_signal_time=datetime(2026, 7, 1, 14, 0),
        entry_price=100.0, entry_sl_price=98.0, entry_tp_price=106.0,
        exit_time=datetime(2026, 7, 1, 15, 0), exit_price=103.0, exit_pnl=300.0,
    )
    bars = [
        {"timestamp": "2026-07-01T14:10:00", "open": 100, "high": 104.0, "low": 99.0, "close": 103, "volume": 1},
    ]
    e = compute_exit_enrichment(entry, bars)
    assert e["r_multiple"] == 1.5  # +3 / 2 risk
    assert e["planned_rr"] == 3.0  # 6 / 2
    assert e["hold_minutes"] == 60.0
    assert e["mfe_pct"] == 4.0  # high 104 vs entry 100
    assert e["mae_pct"] == 1.0  # low 99 vs entry 100
    assert e["capture_pct"] == 75.0  # +3 of available +4
    assert e["exit_verdict"] == "good"


def test_exit_enrichment_short_side():
    entry = JournalModel(
        stock="TEST", setup_id=1, signal_side="short", status="closed",
        entry_signal_time=datetime(2026, 7, 1, 14, 0),
        entry_price=100.0, entry_sl_price=102.0, entry_tp_price=None,
        exit_time=datetime(2026, 7, 1, 14, 30), exit_price=97.0, exit_pnl=300.0,
    )
    e = compute_exit_enrichment(entry, None)
    assert e["r_multiple"] == 1.5  # +3 favorable / 2 risk
    assert e["mae_pct"] is None  # no bars -> best effort skipped
