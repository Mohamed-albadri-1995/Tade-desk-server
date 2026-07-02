"""
STAGE 18 — Statistics Database.

Persists closed trades and answers "how has this setup done?"
questions. SQLite for durability, pandas for reads.

    store = StatsStore('trades.sqlite')
    store.record(close_event)
    store.summary(setup='9:30 breakout')
    store.rolling_expectancy(window=20, setup='9:30 breakout')

Everything downstream (Stage 19 AI, dashboards, journal exports) reads
from this store — no other module should own trade persistence.
"""

from qp.stats.store import StatsStore

__all__ = ['StatsStore']
