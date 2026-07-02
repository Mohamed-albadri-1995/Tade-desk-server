"""
Validation script: dump SPY 5-min EMA(9) so you can compare it to
TradingView bar-for-bar.

Usage:
    python scripts/validate_ema.py --symbol SPY --tf 5m --length 9 --days 5

The script:
    1. Loads bars via the platform's data layer (Yahoo).
    2. Computes EMA with qp.ma.ema.
    3. Writes a CSV `validate_ema_<symbol>_<tf>.csv` with columns
       [ts_utc, ts_et, close, ema, session].
    4. Prints the last N rows so you can eyeball them against
       TradingView side-by-side.

Stage-15 protocol: open TradingView on the same symbol+timeframe, add
EMA(length) on close, and compare the CSV's ema values against
TradingView's EMA line reading at the same timestamps. If every row
matches to ~1e-6, mark `qp.ma.ema` VERIFIED in its module docstring.
"""

import argparse
import sys
from pathlib import Path

import pandas as pd

# Allow running as a script from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qp.data import load
from qp.ma import ema
from qp.session import session_for_bars, US_EQUITIES


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbol', default='SPY')
    parser.add_argument('--tf', default='5m', help='timeframe (1m/5m/1h/1d/...)')
    parser.add_argument('--length', type=int, default=9)
    parser.add_argument('--days', type=int, default=5, help='lookback in calendar days')
    parser.add_argument('--session', default='regular', help='regular / premarket / extended / all')
    args = parser.parse_args()

    end   = pd.Timestamp.now(tz='UTC')
    start = end - pd.Timedelta(days=args.days)

    bars = load(
        args.symbol,
        timeframe=args.tf,
        start=start,
        end=end,
        source='yahoo',
        session=None if args.session == 'all' else args.session,
    )
    if len(bars) == 0:
        print(f'No bars returned for {args.symbol} {args.tf}. Aborting.')
        return 1

    e = ema(bars.df['close'].to_numpy(), args.length)
    session_labels = session_for_bars(bars.df, US_EQUITIES).to_numpy()

    out = pd.DataFrame({
        'ts_utc': bars.df.index.strftime('%Y-%m-%d %H:%M:%S'),
        'ts_et':  bars.df.index.tz_convert('America/New_York').strftime('%Y-%m-%d %H:%M:%S'),
        'close':  bars.df['close'].to_numpy(),
        'ema':    e,
        'session': session_labels,
    })

    out_path = Path(f'validate_ema_{args.symbol}_{args.tf}.csv')
    out.to_csv(out_path, index=False)
    print(f'Wrote {len(out)} rows to {out_path}')
    print()
    print(f'Tail — compare these EMA values to TradingView {args.symbol} {args.tf} EMA({args.length}):')
    print(out.tail(20).to_string(index=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
