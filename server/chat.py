"""Stateless Claude proxy for the explorer's chat (`POST /api/chat`).

The browser sends only `{"messages": [...]}`; model, system prompt, tools, tool_choice, max_tokens and
effort are fixed here and cannot be overridden by the client. The history itself is client-written, so
the server checks its structure (roles, block types, sizes, nesting depth, and that every tool_result
answers a tool_use of the preceding assistant turn and every tool_use is answered), but it cannot stop a
script from asking the fixed model off-topic questions: that use is bounded only by the limits below.
The model acts through tool calls; the page executes them (docs/tng50/js/chat.js) and sends the results
back in the next request. Nothing is stored server-side: limits are per-client token buckets (an IPv6
client counts as its /64), a per-client daily cap, global daily request and token budgets and a
concurrency cap, all in memory (single-process server, as app.py).

Logging never contains message text, tool inputs/results or the key at INFO or above; DEBUG adds
tool names only."""
from __future__ import annotations
import hashlib
import json
import logging
import re
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .ratelimit import RateLimiter, client_ip, client_key

log = logging.getLogger("tngsight.server.chat")

MODEL = "claude-haiku-5-5"
API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
TOOLS: list = json.loads((Path(__file__).with_name("chat_tools.json")).read_text(encoding="utf-8"))
TOOL_NAMES: tuple = tuple(t["name"] for t in TOOLS)
# Generated from tngsight/ions.json by `python -m server.make_chat_tools` (design.md §4.3); the page's
# docs/tng50/js/chat.js carries the same text (tests/js/chat_tools_sync.mjs).
SYSTEM_PROMPT: str = (Path(__file__).with_name("chat_system_prompt.txt")).read_text(encoding="utf-8").strip()

MAX_TEXT = 4000                 # user text / text block
MAX_ASSISTANT_TEXT = 6000       # assistant text: a 1024-token reply is ~4-5 k characters; leaves headroom
MAX_RESULT = 8000               # tool_result content
MAX_INPUT_DEPTH = 8             # nesting of a tool_use input (the deepest tool schema needs 3)
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_PASS_TYPES = ("text", "tool_use", "thinking", "redacted_thinking")   # response block types forwarded
_BLOCK_KEYS = {"text": ("type", "text"), "tool_use": ("type", "id", "name", "input"),
               "thinking": ("type", "thinking", "signature"), "redacted_thinking": ("type", "data")}


class ChatError(ValueError):
    """A message-validation failure (422 with this short reason)."""


def _depth(x, limit, d=1):
    """True when the JSON value `x` nests no deeper than `limit` containers (iterative-safe for the limit)."""
    if isinstance(x, dict):
        return d <= limit and all(_depth(v, limit, d + 1) for v in x.values())
    if isinstance(x, list):
        return d <= limit and all(_depth(v, limit, d + 1) for v in x)
    return True


def enabled(settings) -> bool:
    return bool(settings.anthropic_api_key) and bool(settings.chat_claude)


def health_fragment(settings) -> dict:
    return {"claude": enabled(settings)}


def _keys(block, required, optional=(), where=""):
    ks = set(block)
    miss = [k for k in required if k not in ks]
    extra = sorted(ks - set(required) - set(optional))
    if miss:
        raise ChatError(f"{where}: missing key {miss[0]!r}")
    if extra:
        raise ChatError(f"{where}: unexpected key {extra[0]!r}")


def _text_block(b, where):
    _keys(b, ("type", "text"), where=where)
    if not isinstance(b["text"], str) or len(b["text"]) > MAX_TEXT:
        raise ChatError(f"{where}: text must be a string of at most {MAX_TEXT} characters")


def _user_block(b, where):
    t = b.get("type")
    if t == "text":
        return _text_block(b, where)
    if t == "tool_result":
        _keys(b, ("type", "tool_use_id", "content"), ("is_error",), where)
        if not isinstance(b["tool_use_id"], str) or not _ID_RE.match(b["tool_use_id"]):
            raise ChatError(f"{where}: bad tool_use_id")
        c = b["content"]
        if isinstance(c, str):
            if len(c) > MAX_RESULT:
                raise ChatError(f"{where}: tool_result content exceeds {MAX_RESULT} characters")
        elif isinstance(c, list) and c:
            for j, x in enumerate(c):
                if not isinstance(x, dict) or x.get("type") != "text":
                    raise ChatError(f"{where}.content[{j}]: only text blocks are allowed")
                _text_block(x, f"{where}.content[{j}]")
        else:
            raise ChatError(f"{where}: tool_result content must be a string or text blocks")
        if "is_error" in b and not isinstance(b["is_error"], bool):
            raise ChatError(f"{where}: is_error must be a boolean")
        return
    raise ChatError(f"{where}: block type {str(t)[:30]!r} not allowed in a user message")


def _assistant_block(b, where):
    t = b.get("type")
    if t == "text":
        # API responses may carry "citations": null on text blocks; accept exactly that so the verbatim
        # round trip of a response never fails validation
        _keys(b, ("type", "text"), ("citations",), where)
        if b.get("citations", None) is not None:
            raise ChatError(f"{where}: citations are not allowed")
        if not isinstance(b["text"], str) or len(b["text"]) > MAX_ASSISTANT_TEXT:
            raise ChatError(f"{where}: text must be a string of at most {MAX_ASSISTANT_TEXT} characters")
        return
    if t == "tool_use":
        _keys(b, ("type", "id", "name", "input"), where=where)
        if not isinstance(b["id"], str) or not _ID_RE.match(b["id"]):
            raise ChatError(f"{where}: bad tool_use id")
        if b["name"] not in TOOL_NAMES:
            raise ChatError(f"{where}: unknown tool {str(b['name'])[:40]!r}")
        if not isinstance(b["input"], dict):
            raise ChatError(f"{where}: tool_use input must be an object")
        if not _depth(b["input"], MAX_INPUT_DEPTH):
            raise ChatError(f"{where}: tool_use input nests deeper than {MAX_INPUT_DEPTH} levels")
        return
    if t == "thinking":
        _keys(b, ("type", "thinking", "signature"), where=where)
        if not isinstance(b["thinking"], str) or not isinstance(b["signature"], str):
            raise ChatError(f"{where}: bad thinking block")
        return
    if t == "redacted_thinking":
        _keys(b, ("type", "data"), where=where)
        if not isinstance(b["data"], str):
            raise ChatError(f"{where}: bad redacted_thinking block")
        return
    raise ChatError(f"{where}: block type {str(t)[:30]!r} not allowed in an assistant message")


def validate_messages(messages, settings) -> list:
    """Return `messages` unchanged when valid, else raise ChatError (-> 422) with a short reason."""
    if not isinstance(messages, list) or not messages:
        raise ChatError("messages must be a non-empty list")
    if len(messages) > settings.chat_max_messages:
        raise ChatError(f"at most {settings.chat_max_messages} messages")
    for i, m in enumerate(messages):
        where = f"messages[{i}]"
        if not isinstance(m, dict):
            raise ChatError(f"{where}: must be an object")
        _keys(m, ("role", "content"), where=where)
        role, c = m["role"], m["content"]
        if role not in ("user", "assistant"):
            raise ChatError(f"{where}: role must be 'user' or 'assistant'")
        if i == 0 and role != "user":
            raise ChatError("the first message must have role 'user'")
        check = _user_block if role == "user" else _assistant_block
        if isinstance(c, str):
            cap = MAX_TEXT if role == "user" else MAX_ASSISTANT_TEXT
            if len(c) > cap:
                raise ChatError(f"{where}: content exceeds {cap} characters")
        elif isinstance(c, list) and c:
            for j, b in enumerate(c):
                if not isinstance(b, dict):
                    raise ChatError(f"{where}.content[{j}]: must be an object")
                check(b, f"{where}.content[{j}]")
        else:
            raise ChatError(f"{where}: content must be a string or a non-empty list of blocks")
    if messages[-1]["role"] != "user":
        raise ChatError("the last message must have role 'user' (no prefill)")
    _check_tool_pairing(messages)
    try:
        size = len(json.dumps(messages, separators=(",", ":"), ensure_ascii=False).encode())
    except UnicodeEncodeError:
        raise ChatError("messages must be valid Unicode (no lone surrogates)") from None
    except RecursionError:
        raise ChatError("messages nest too deeply") from None
    if size > settings.chat_max_bytes:
        raise ChatError(f"messages exceed {settings.chat_max_bytes} bytes")
    return messages


def _blocks(m, kind):
    c = m["content"]
    return [b for b in c if b.get("type") == kind] if isinstance(c, list) else []


def _check_tool_pairing(messages):
    """Each run of user messages may only answer the tool_use blocks of the assistant message right before
    it (each exactly once), and must answer all of them; consecutive user messages count as one turn, as
    the Messages API merges them."""
    pending, answered = None, set()
    for i, m in enumerate(messages):
        if m["role"] == "assistant":
            if pending:
                raise ChatError(f"messages[{i}]: the previous assistant turn has unanswered tool_use blocks")
            ids = [b["id"] for b in _blocks(m, "tool_use")]
            if len(set(ids)) != len(ids):
                raise ChatError(f"messages[{i}]: duplicate tool_use id")
            pending, answered = set(ids), set()
            continue
        for b in _blocks(m, "tool_result"):
            t = b["tool_use_id"]
            if not pending or t not in pending:
                raise ChatError(f"messages[{i}]: tool_result does not answer a tool_use of the preceding "
                                "assistant turn")
            if t in answered:
                raise ChatError(f"messages[{i}]: tool_use answered twice")
            answered.add(t)
        nxt = messages[i + 1]["role"] if i + 1 < len(messages) else None
        if nxt != "user":                                     # end of this user turn
            if pending and answered != pending:
                raise ChatError(f"messages[{i}]: not every tool_use of the preceding assistant turn is answered")
            pending, answered = None, set()


def _seconds_to_utc_midnight(now: float) -> int:
    return max(1, int(86400 - (now % 86400) + 0.999))


def _retry_after(resp, default=30) -> str:
    v = resp.headers.get("retry-after", "")
    try:
        return str(max(1, min(3600, int(float(v)))))
    except ValueError:
        return str(default)


def _err(status, detail, retry=None):
    return JSONResponse({"detail": detail}, status, headers={"Retry-After": str(retry)} if retry else None)


def make_router(settings, transport=None, clock=time.time) -> APIRouter:
    """`transport`: an httpx transport (tests use httpx.MockTransport); `clock`: wall clock for the
    daily budget (UTC days)."""
    S = settings
    router = APIRouter()
    limiter = RateLimiter({"chat": S.rl_chat})
    day = {"day": None, "n": 0, "tokens": 0, "per": {}}      # per: {client key: requests today}
    inflight = [0]

    @router.post("/api/chat")
    async def chat(request: Request):
        t0 = time.monotonic()
        if not enabled(S):
            return _err(404, "chat disabled")
        ip = client_ip(request, S.trust_proxy, S.trusted_hops)
        who = client_key(ip)                                  # IPv6: the /64
        iph = hashlib.sha256(ip.encode()).hexdigest()[:12]
        raw = await request.body()
        rid, usage, n_msg = None, None, None

        def done(resp):
            log.info("chat ip=%s n_messages=%s bytes=%d status=%d latency_ms=%d request_id=%s usage=%s",
                     iph, n_msg, len(raw), resp.status_code, int(1000 * (time.monotonic() - t0)), rid,
                     json.dumps(usage, separators=(",", ":")) if usage else None)
            return resp
        try:
            body = json.loads(raw)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return done(_err(422, "body must be JSON (nesting is limited)"))
        if not isinstance(body, dict) or set(body) != {"messages"}:
            extra = sorted(set(body) - {"messages"}) if isinstance(body, dict) else []
            return done(_err(422, f"unexpected field {extra[0]!r}; the body is {{\"messages\": [...]}} only"
                             if extra else "body must be {\"messages\": [...]}"))
        msgs = body["messages"]
        n_msg = len(msgs) if isinstance(msgs, list) else None
        try:
            validate_messages(msgs, S)
        except ChatError as e:
            return done(_err(422, str(e)))
        wait = limiter.check("chat", who)
        if wait > 0:
            s = max(1, int(wait + 0.999))
            return done(_err(429, f"rate limit exceeded for chat; retry in {s} s", s))
        now = clock()
        d = int(now // 86400)
        if day["day"] != d:
            day.update(day=d, n=0, tokens=0, per={})
        if day["n"] >= S.chat_daily_budget or (S.chat_daily_tokens and day["tokens"] >= S.chat_daily_tokens):
            limiter.refund("chat", who)
            return done(_err(429, "daily chat budget exhausted", _seconds_to_utc_midnight(now)))
        if day["per"].get(who, 0) >= S.chat_client_daily_budget:
            limiter.refund("chat", who)
            return done(_err(429, "daily chat limit for this client reached", _seconds_to_utc_midnight(now)))
        if inflight[0] >= S.chat_max_concurrent:
            limiter.refund("chat", who)
            return done(_err(503, "chat is busy; try again shortly", 5))
        day["n"] += 1
        if len(day["per"]) >= 100000 and who not in day["per"]:  # bound memory; a flood keeps its old counts
            day["per"].pop(next(iter(day["per"])))
        day["per"][who] = day["per"].get(who, 0) + 1
        inflight[0] += 1
        payload = {"model": MODEL, "max_tokens": min(int(S.chat_max_tokens), 1024), "system": SYSTEM_PROMPT,
                   "tools": TOOLS, "tool_choice": {"type": "auto"}, "output_config": {"effort": "low"},
                   "messages": msgs}
        if log.isEnabledFor(logging.DEBUG):
            names = [b.get("name") for m in msgs if isinstance(m.get("content"), list)
                     for b in m["content"] if b.get("type") == "tool_use"]
            log.debug("chat ip=%s tools_in_history=%s", iph, names)
        headers = {"x-api-key": S.anthropic_api_key, "anthropic-version": ANTHROPIC_VERSION,
                   "content-type": "application/json"}
        try:
            async with httpx.AsyncClient(transport=transport,
                                         timeout=httpx.Timeout(S.chat_timeout_s, connect=5.0)) as cli:
                up = await cli.post(API_URL, content=json.dumps(payload, ensure_ascii=False).encode(),
                                    headers=headers)
        except httpx.TimeoutException:
            return done(_err(504, "upstream timed out"))
        except httpx.HTTPError as e:
            log.warning("chat ip=%s upstream connection error: %s", iph, type(e).__name__)
            return done(_err(503, "upstream unavailable", 30))
        finally:
            inflight[0] -= 1
        rid = up.headers.get("request-id")
        if up.status_code in (429, 529) or up.status_code >= 500:
            return done(_err(503, "the model service is busy; try again shortly", _retry_after(up)))
        if up.status_code != 200:
            return done(_err(502, "upstream rejected the request"))
        try:
            r = up.json()
            content = r["content"]
            if not isinstance(content, list) or any(not isinstance(b, dict) or b.get("type") not in _PASS_TYPES
                                                    for b in content):
                raise ValueError("unsupported content block")
            # forward only the keys the request validator accepts back: the API adds response-only fields
            # (e.g. "caller" on tool_use) that would make the next turn's round trip fail with a 422
            content = [{k: b[k] for k in _BLOCK_KEYS[b["type"]] if k in b} for b in content]
            u = r.get("usage") or {}
            usage = {"input_tokens": u.get("input_tokens"), "output_tokens": u.get("output_tokens")}
            day["tokens"] += sum(x for x in usage.values() if isinstance(x, int) and not isinstance(x, bool)
                                 and x > 0)
            out = {"content": content, "stop_reason": r.get("stop_reason"), "usage": usage}
        except (ValueError, KeyError, TypeError):
            return done(_err(502, "unexpected upstream response"))
        if log.isEnabledFor(logging.DEBUG):
            log.debug("chat ip=%s tool_use=%s", iph, [b.get("name") for b in content if b.get("type") == "tool_use"])
        return done(JSONResponse(out))

    return router
