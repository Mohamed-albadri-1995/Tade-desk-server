"""Yahoo WITH its own premarket and after-hours — one source, more hours.

For a setup whose strategy reads a premarket level (levels.pm_high,
levels.pm_low, vwap.gap). The desk's default live feed, `yahoo`, is fetched for
the regular session only, so such a strategy would read nothing before 09:30
and never fire — live or in a backtest of the bars live has.

NOT A MERGE. Premarket from a second source spliced onto Yahoo's regular
session was tried and gave awful results; this asks the SAME source for more
hours (includePrePost=true), so there is no seam to go wrong. The desk switches
a setup to it by itself when the strategy needs it (src/setups/feeds.js).
"""
from tools.data import yahoo


def load(symbol, timeframe, start, end, feed='yahoo_ext', live=False):
    return yahoo.load(symbol, timeframe, start, end, prepost=True, live=live)
