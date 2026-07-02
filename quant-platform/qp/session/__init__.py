"""
STAGE 2 — Session Engine.

Everything to do with market time. If any function elsewhere is asking
"is this bar in premarket?" or "when did the session open?", it goes
through here.

US equities are the initial target market; the SessionSpec model is
generic enough to represent 24h markets (crypto), other exchanges, or
custom session windows for research.
"""

from qp.session.engine import (
    SessionSpec,
    US_EQUITIES,
    is_regular,
    is_premarket,
    is_after_hours,
    is_extended,
    current_session,
    session_open,
    session_close,
    session_length_minutes,
    session_index,
    session_for_bars,
)

__all__ = [
    'SessionSpec', 'US_EQUITIES',
    'is_regular', 'is_premarket', 'is_after_hours', 'is_extended',
    'current_session',
    'session_open', 'session_close', 'session_length_minutes', 'session_index',
    'session_for_bars',
]
