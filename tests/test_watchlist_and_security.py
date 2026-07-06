import pytest

from app.routers.watchlist import parse_watchlist_file
from app.security import decrypt, encrypt


def test_csv_with_header():
    content = b"ticker,price\nAAPL,190\nmsft,410\nAAPL,191\n"
    assert parse_watchlist_file("list.csv", content) == ["AAPL", "MSFT"]


def test_csv_headerless():
    content = b"AAPL\nMSFT\nNVDA\n"
    assert parse_watchlist_file("list.csv", content) == ["AAPL", "MSFT", "NVDA"]


def test_json_records():
    content = b'[{"ticker": "aapl"}, {"ticker": "TSLA"}, {"name": "no-ticker"}]'
    assert parse_watchlist_file("list.json", content) == ["AAPL", "TSLA"]


def test_json_plain_strings():
    content = b'["spy", "qqq"]'
    assert parse_watchlist_file("list.json", content) == ["SPY", "QQQ"]


def test_rejects_other_extensions():
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        parse_watchlist_file("list.txt", b"AAPL")


def test_encrypt_roundtrip():
    secret = "PK1234567890abcdef"
    token = encrypt(secret)
    assert token != secret
    assert secret not in token
    assert decrypt(token) == secret
    assert encrypt("") == ""
    assert decrypt("") == ""
