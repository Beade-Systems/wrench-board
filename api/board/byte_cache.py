"""Bounded, thread-safe LRU of encoded payloads with per-key single flight.

Concurrent misses on one key run `build` once; the others wait for its result.
Failed builds are never cached and propagate to every waiter.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable, Hashable
from concurrent.futures import Future
from threading import Lock


class ByteCache:
    def __init__(self, max_bytes: int, max_entries: int):
        if max_bytes < 0 or max_entries < 1:
            raise ValueError("invalid cache limits")
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._bytes = 0
        self._entries: OrderedDict[Hashable, bytes] = OrderedDict()
        self._inflight: dict[Hashable, Future] = {}
        self._lock = Lock()

    def get_or_build(self, key: Hashable, build: Callable[[], bytes]) -> bytes:
        with self._lock:
            if key in self._entries:
                self._entries.move_to_end(key)
                return self._entries[key]
            future = self._inflight.get(key)
            leader = future is None
            if leader:
                future = self._inflight[key] = Future()
        if not leader:
            return future.result()
        try:
            encoded = build()
            with self._lock:
                if len(encoded) <= self._max_bytes:
                    while self._entries and (
                        self._bytes + len(encoded) > self._max_bytes
                        or len(self._entries) >= self._max_entries
                    ):
                        _, old = self._entries.popitem(last=False)
                        self._bytes -= len(old)
                    self._entries[key] = encoded
                    self._bytes += len(encoded)
            future.set_result(encoded)
            return encoded
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self._lock:
                del self._inflight[key]
