"""Per-client token buckets (in-memory; fine for the single-process server)."""
from __future__ import annotations
import math
import threading
import time
from collections import OrderedDict


class TokenBucket:
    """`burst` tokens, refilled at `per_hour`/3600 tokens per second."""

    def __init__(self, per_hour, burst, clock=time.monotonic):
        self.rate, self.cap, self.clock = per_hour / 3600.0, float(burst), clock
        self.tokens, self.t = float(burst), clock()

    def take(self) -> float:
        """Consume one token. Returns 0 on success, else seconds until one is available."""
        now = self.clock()
        self.tokens = min(self.cap, self.tokens + (now - self.t) * self.rate)
        self.t = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return 0.0
        return (1.0 - self.tokens) / self.rate if self.rate > 0 else math.inf

    def give(self):
        """Return one token (the charged action did not happen)."""
        self.tokens = min(self.cap, self.tokens + 1.0)


class RateLimiter:
    """Named limits, one bucket per (name, client), kept in an LRU capped at `max_clients`
    (O(1) per check; the least recently used bucket is evicted first)."""

    def __init__(self, limits: dict, clock=time.monotonic, max_clients=10000):
        self.limits, self.clock, self.max_clients = dict(limits), clock, max_clients
        self._b: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def check(self, name, client) -> float:
        per_hour, burst = self.limits[name]
        key = (name, client)
        with self._lock:
            b = self._b.get(key)
            if b is None:
                b = self._b[key] = TokenBucket(per_hour, burst, self.clock)
                while len(self._b) > self.max_clients:
                    self._b.popitem(last=False)
            else:
                self._b.move_to_end(key)
            return b.take()

    def refund(self, name, client):
        """Give back the token a check() took (e.g. the request was then refused with 503)."""
        with self._lock:
            b = self._b.get((name, client))
            if b is not None:
                b.give()

    def __len__(self):
        return len(self._b)


def client_ip(request, trust_proxy: bool, trusted_hops: int = 1) -> str:
    """Behind `trusted_hops` trusted proxies (HF Space: 1), the client is the hop the outermost
    trusted proxy appended, i.e. the `trusted_hops`-th entry from the RIGHT of X-Forwarded-For.
    Entries to the left of it are client-supplied and never used. Else the peer address."""
    if trust_proxy:
        hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",")]
        hops = [h for h in hops if h]
        if hops:
            return hops[-min(max(int(trusted_hops), 1), len(hops))][:64]
    return request.client.host if request.client else "unknown"
