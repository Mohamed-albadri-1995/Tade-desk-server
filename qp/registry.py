"""Primitive registry for the qp library."""

from dataclasses import dataclass, field
from typing import Callable, Dict


@dataclass(frozen=True)
class Primitive:
    key: str
    fn: Callable
    description: str = ""
    params: dict = field(default_factory=dict)


REGISTRY: Dict[str, Primitive] = {}


def register(key: str, description: str = "", **default_params):
    """Decorator that registers a primitive function under ``key``.

    Primitive functions take ``bars`` (a list of OHLCV dicts with keys
    ``open``, ``high``, ``low``, ``close``, ``volume``, ``timestamp``)
    as their first argument, followed by keyword parameters.
    """

    def decorator(fn: Callable) -> Callable:
        REGISTRY[key] = Primitive(key=key, fn=fn, description=description, params=default_params)
        return fn

    return decorator
