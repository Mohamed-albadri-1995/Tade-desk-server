"""Symmetric encryption for broker credentials, keyed by SECRET_KEY.

Uses HMAC-SHA256 keystream (stdlib only) so encrypted values are never
stored or returned in plaintext. Format: base64(nonce || ciphertext).
"""

import base64
import hashlib
import hmac
import os

from app.config import settings


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    stream = b""
    counter = 0
    while len(stream) < length:
        stream += hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return stream[:length]


def _key() -> bytes:
    return hashlib.sha256(settings.secret_key.encode("utf-8")).digest()


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    data = plaintext.encode("utf-8")
    nonce = os.urandom(16)
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(_key(), nonce, len(data))))
    return base64.urlsafe_b64encode(nonce + cipher).decode("ascii")


def decrypt(token: str) -> str:
    if not token:
        return ""
    raw = base64.urlsafe_b64decode(token.encode("ascii"))
    nonce, cipher = raw[:16], raw[16:]
    data = bytes(a ^ b for a, b in zip(cipher, _keystream(_key(), nonce, len(cipher))))
    return data.decode("utf-8")
