"""DES compatibility and the order/scope of XZZ's two decryption steps."""

import struct

from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
from cryptography.hazmat.primitives.ciphers import Cipher, modes

from api.board.parser._xzz_engine.decryptor import decrypt_with_des
from api.board.parser._xzz_engine.xzz_file import DEFAULT_XZZ_KEY, XZZFile


def test_des_matches_published_known_answer():
    # Standard DES example, independent of the implementation's encrypt path.
    assert decrypt_with_des(bytes.fromhex("85E813540F0AB405"), "133457799BBCDFF1") == bytes.fromhex(
        "0123456789ABCDEF"
    )


def test_standard_key_matches_reference_derivation():
    values = [0xE0, 0xCF, 0x2E, 0x9F, 0x3C, 0x33, 0x3C, 0x33]
    derived = "".join(f"{((values[i] << 8) | values[i + 1]) ^ 0x3C33:04X}" for i in range(0, 8, 2))
    assert DEFAULT_XZZ_KEY == derived == "DCFC12AC00000000"


def _fixture(key):
    plain = b"PARTDATA" * 2  # Repeated blocks must decrypt independently (ECB).
    encryptor = Cipher(TripleDES(bytes.fromhex(key)), modes.ECB()).encryptor()
    ciphertext = encryptor.update(plain) + encryptor.finalize()
    blocks = (
        b"\x03"
        + struct.pack("<I", 3)
        + b"raw"
        + b"\x07"
        + struct.pack("<I", len(ciphertext))
        + ciphertext
    )
    header = bytearray(0x44)
    header[:6] = b"XZZPCB"
    struct.pack_into("<I", header, 0x40, len(blocks))
    return bytes(header) + blocks, plain


def test_xor_precedes_des_and_post_v6_is_unchanged(monkeypatch):
    monkeypatch.setattr(XZZFile, "MASTER_KEY", DEFAULT_XZZ_KEY)
    data, plain = _fixture(DEFAULT_XZZ_KEY)
    tail = XZZFile.DIODE_PATTERN + b"diagnostic metadata"
    xor_key = 0x5A
    encrypted = bytes(byte ^ xor_key for byte in data) + tail
    result = XZZFile()._decrypt_file(encrypted)
    assert result[:6] == b"XZZPCB"
    assert result[0x10] == 0
    assert result[0x44 + 5 : 0x44 + 8] == b"raw"
    assert result[0x44 + 13 : 0x44 + 13 + len(plain)] == plain
    assert result.endswith(tail)


def test_vendor_key_override_and_no_xor(monkeypatch):
    key = "0011223344556677"
    monkeypatch.setattr(XZZFile, "MASTER_KEY", key)
    data, plain = _fixture(key)
    assert XZZFile()._decrypt_file(data)[-len(plain) :] == plain
