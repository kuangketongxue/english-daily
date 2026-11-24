#!/usr/bin/env python3
"""Parallel web search aggregator with quota routing, ranking and caching.

Fans one query out to every enabled backend in parallel, then returns a single
ranked, deduplicated list:

  - exa            Exa neural search (PRIMARY — highest trust weight, first
                   in the fan-out; set EXA_API_KEY to enable)
  - yuanbao        Tencent Yuanbao Search /SearchPro (CN-first, 157 authoritative
                   vertical sources, minutely-fresh news/policy/quotes)
  - firecrawl      Firecrawl /v2/search (N keys, each tracked independently)
  - firecrawl_news Firecrawl /v2/search with sources=["news"] (optional)
  - tavily         Tavily /search (N keys, each tracked independently)
  - zhihu          Zhihu site search  (developer.zhihu.com OpenAPI)
  - global         Zhihu global search (developer.zhihu.com OpenAPI)
  - http:<id>      Generic HTTP search API, configured in config.json

Exa is the primary backend: it is embedding-ranked rather than keyword-matched,
so its results lead when several backends are live. Firecrawl's keyless tier
keeps the skill working with zero configuration.

Design notes
------------
* A backend is never permanently disabled. Out-of-quota / auth failures put it
  on a cooldown (default 1h; plan-cap failures get a much longer one) and the
  next run retries it.
* Zhihu signals failures through a *business* code inside an HTTP 200 body
  (``Code != 0``). HTTP status alone is not enough — we check both.
* A slow backend must never take down the whole run: the fan-out waits with a
  deadline and harvests whatever finished in time.
* Results are scored and sorted, not concatenated in completion order. A URL
  found by several backends ranks higher (cross-source consensus).

Usage
-----
  python parallel_search.py '{"query":"..."}'
  python parallel_search.py '{"query":"...","top_k":20,"no_cache":true}'
  python parallel_search.py --query "..." --top-k 20
  python parallel_search.py --check          # per-backend health probe
  python parallel_search.py --list-backends

Output: JSON on stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed, wait
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
SKILL_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = SKILL_DIR / "config.json"
STATE_DIR = SKILL_DIR / "state"
COOLDOWN_PATH = STATE_DIR / "cooldowns.json"
# Local call counter that hard-stops Yuanbao at the free tier. Billing is
# per call, so one call over the free allowance becomes real money — this file
# is the only thing standing between "free" and "an invoice".
YUANBAO_QUOTA_PATH = STATE_DIR / "yuanbao_quota.json"
CACHE_DIR = STATE_DIR / "cache"

FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/search"
# docs: 1 <= limit <= 100, default 10. Why the limit is derived from top_k
# rather than fixed sits with FETCH_FACTORS.
FIRECRAWL_LIMIT_KEYED = 100
FIRECRAWL_LIMIT_KEYLESS = 30
FIRECRAWL_COST_ESTIMATE_PER_10 = 2.0   # the rate --estimate quotes

# Exa is the PRIMARY backend (highest trust weight, enabled by default).
# Neural/embedding retrieval — better semantic matches than keyword engines,
# which is why it leads when both are live.
# docs: 1 <= numResults <= 100; base price covers the first 10 results.
EXA_ENDPOINT = "https://api.exa.ai/search"
EXA_MAX_RESULTS = 100
# Exa bills a base rate covering the first 10 results; results past that are
# charged per result. numResults is therefore derived from top_k with a floor of
# 10, so asking for 5 does not pay for25.
EXA_BASE_RESULTS = 10
EXA_TYPES = ("auto", "neural", "keyword", "fast",
             "deep-lite", "deep", "deep-reasoning")

TAVILY_ENDPOINT = "https://api.tavily.com/search"
TAVILY_MAX_RESULTS = 20# docs: 0 <= max_results <= 20

ZHIHU_ENDPOINT = "https://developer.zhihu.com/api/v1/content/zhihu_search"
ZHIHU_COUNT = 10                 # server clamps to 10

GLOBAL_ENDPOINT = "https://developer.zhihu.com/api/v1/content/global_search"
GLOBAL_COUNT = 20                # server clamps to 20

# Tencent Yuanbao Search (元宝搜索 / product 1806, action SearchPro).
# Two auth schemes exist: the standard TC3-HMAC-SHA256 cloud signature, and the
# simpler "service API KEY" scheme (docs 1806/130615) which is a plain
# `Authorization: Bearer sk-...` header. We use the key scheme on purpose — no
# signing code, no clock-skew failures, and the same key works for the MCP
# endpoint. Billing is per CALL (14/20/26 CNY per 1000 by tier), so page size is
# free: there is nothing to save by asking for fewer results.
# docs: https://cloud.tencent.com/document/product/1806/121811
YUANBAO_ENDPOINT = "https://api.wsa.cloud.tencent.com/SearchPro"
# Cnt is an enum, not a range: 10/20/30/40/50. Anything else is rejected.
YUANBAO_CNT_STEPS = (10, 20, 30, 40, 50)
YUANBAO_MAX_CNT = YUANBAO_CNT_STEPS[-1]
YUANBAO_MODES = {0: "web", 1: "vertical", 2: "mixed"}
YUANBAO_INDUSTRIES = ("gov", "news", "acad", "finance")
# Standard tier list price, CNY per call. The first 2000 calls each calendar
# month are free, so in practice a homelab run costs 0.
YUANBAO_CNY_PER_CALL = 0.02
YUANBAO_FREE_CALLS_PER_MONTH = 2000
# Freshness grammar: dN (1-30 days) / mN (1-12 months) / yN (1-5 years) /
# yyyy-mm-dd / "yyyy-mm-dd,yyyy-mm-dd". Shapes must not be mixed.
YUANBAO_FRESHNESS_RE = re.compile(
    r"^(?:[dmy](?:[1-9]|[12]\d|30)?|\d{4}-\d{2}-\d{2}(?:,\d{4}-\d{2}-\d{2})?)$")

# Zhihu business codes (docs: Code==0 means success).
ZHIHU_OK = 0
ZHIHU_CODES = {
    10001: "invalid_params",
    20001: "auth_failed",
    30001: "rate_limited",
    90001: "internal_error",
}

HTTP_TIMEOUT = 20
FIRECRAWL_CLI_TIMEOUT = 60
FUTURE_TIMEOUT = 90              # hard deadline for the whole fan-out
COOLDOWN_SECONDS_DEFAULT = 3600
# 432/433 are plan-cap / pay-as-you-go-cap on Tavily: they do not recover in an
# hour, but they are billing events, not bugs — cool them down for a day.
COOLDOWN_SECONDS_PLAN_CAP = 86400
# 20001 (bad Access Secret) only recovers when the human edits config.json.
COOLDOWN_SECONDS_AUTH = 21600
# An IP-based refusal is an environment property: it persists until the network
# changes, so retrying sooner just burns requests.
COOLDOWN_SECONDS_IP_BLOCK = 86400

DEFAULT_TOP_K = 20
CACHE_TTL_SECONDS = 86400

# Cost control. Every paid backend bills per result, so fetching a fixed large
# page regardless of what the caller asked for wastes money on rows the ranker
# would discard. Fetch sizes are derived from top_k with an oversample factor:
# enough candidates to survive dedup and to detect cross-source consensus, not
# more. The factors differ because the marginal unit differs:
#
#   Exa       $0.007 flat for the first 10 results, then $0.001 each -- paying
#             for rows 11+ is real money, so it oversamples least.
#   Firecrawl measured credits 10->2  25->6  50->10  100->16: the marginal
#             result gets *cheaper* with volume (0.27 cr over 10-25, 0.12 cr
#             over 50-100), so it can afford the widest net.
#   Tavily    1 credit per basic search however many results come back. It is
#             absent from the table on purpose: shrinking its max_results would
#             cut recall while the invoice stayed identical.
#
# Cross-backend overlap means fetching far beyond top_k + what the other
# backends return is dead weight, and the answer is truncated to top_k anyway:
# extra rows are insurance for the case where other backends drop out mid-run,
# not a better page. So Exa oversamples just enough to cover that, while
# Firecrawl -- whose marginal credit price falls with volume -- carries the
# wider net that actually improves cross-source consensus detection.
COST_MODE = "balanced"   # cheap | balanced | thorough
FETCH_FACTORS = {
    "cheap":    {"exa": 1.0, "firecrawl": 1.5, "yuanbao": 1.2},
    "balanced": {"exa": 1.3, "firecrawl": 2.0, "yuanbao": 1.5},
    "thorough": {"exa": 2.0, "firecrawl": 3.0, "yuanbao": 2.5},
}
MIN_FETCH = 10# provider base tier; asking below this costs the same and returns less

# Hard ceilings taken from each API's own docs; plan_fetch clamps to these.
PROVIDER_CEILINGS = {
    "exa": EXA_MAX_RESULTS,
    "firecrawl": FIRECRAWL_LIMIT_KEYED,
    "tavily": TAVILY_MAX_RESULTS,
    "yuanbao": YUANBAO_MAX_CNT,
}

# Backend trust weights used by the ranker. Exa leads: it is the primary
# backend and its neural retrieval tends to return the most on-topic pages.
# Yuanbao is deliberately kept BELOW Firecrawl: it ranks with an LLM over 157
# curated vertical sources and refreshes news/policy/quotes by the minute, which
# is excellent signal on Chinese queries — but its retrieval is still lexical,
# so its recall is narrower than a broad crawler's. Owner's standing order is
# exa > firecrawl > everything else (2026-10-21).
SOURCE_WEIGHTS = {
    "exa": 1.00,
    "firecrawl": 0.95,
    "yuanbao": 0.93,
    "tavily": 0.92,
    "zhihu": 0.88,
    "global": 0.85,
}

# Words too common to carry relevance signal.
STOPWORDS = {
    # English
    "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are",
    "was", "were", "be", "been", "it", "its", "this", "that", "these", "those",
    "with", "as", "at", "by", "from", "how", "what", "why", "when", "where",
    "which", "who", "do", "does", "did", "can", "could", "should", "would",
    "will", "i", "you", "we", "they", "he", "she", "my", "your", "our",
    "about", "into", "over", "than", "then", "there", "here", "have", "has",
    "had", "not", "but", "if", "so", "such", "use", "using", "used", "best",
    "vs", "versus", "etc", "e.g", "i.e",
    # Chinese (single chars are too noisy on their own; bigrams do the work)
    "的", "了", "和", "是", "在", "我", "有", "就", "不", "人", "都", "一",
    "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有",
    "看", "好", "自己", "这", "那", "与", "及", "或", "吗", "呢", "吧", "啊",
}

CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
WORD_RE = re.compile(r"[a-z0-9][a-z0-9+#.\-_]*", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def _truncate(v: Any, n: int = 300) -> str:
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    return str(v)[:n]


def _dig(obj: Any, path: str, default: Any = None) -> Any:
    """Walk a dotted path such as ``data.web`` through nested dicts/lists."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            idx = int(part)
            cur = cur[idx] if idx < len(cur) else None
        else:
            return default
        if cur is None:
            return default
    return cur


def _write_atomic(path: Path, payload: str) -> None:
    """Write via temp file + replace so concurrent runs cannot corrupt state."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Query analysis for the ranker
# ---------------------------------------------------------------------------
def query_terms(query: str) -> List[str]:
    """Split a query into comparable terms.

    Latin words are taken as-is. CJK runs have no spaces, so they are expanded
    into character bigrams — crude next to a real segmenter, but it needs no
    third-party dependency and behaves well enough for scoring.
    """
    terms: List[str] = []
    for w in WORD_RE.findall(query):
        lw = w.lower()
        if len(lw) > 1 and lw not in STOPWORDS:
            terms.append(lw)

    for run in re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf]+", query):
        for ch in run:
            if ch not in STOPWORDS:
                terms.append(ch)
        for i in range(len(run) - 1):
            terms.append(run[i:i + 2])
    return terms


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    return CJK_RE.sub(lambda m: m.group(0), text)


def _host_of(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "", re.IGNORECASE)
    return m.group(1).lower().removeprefix("www.") if m else ""


def _canonical_url(url: str) -> str:
    """Normalize a URL for dedupe: drop scheme/www, fragment and trackers."""
    u = (url or "").strip()
    u = re.sub(r"^https?://", "", u, flags=re.IGNORECASE)
    u = re.sub(r"^www\.", "", u, flags=re.IGNORECASE)
    u = u.split("#", 1)[0]
    # strip tracking query params that never change the document
    if "?" in u:
        base, qs = u.split("?", 1)
        keep = [
            p for p in qs.split("&")
            if p and not p.split("=", 1)[0].lower().startswith(
                ("utm_", "spm", "from_", "ref_", "share_", "src_", "_hsenc")
            )
        ]
        u = base + ("?" + "&".join(sorted(keep)) if keep else "")
    return u.rstrip("/").lower()


# ---------------------------------------------------------------------------
# Config & credentials
# ---------------------------------------------------------------------------
def load_config() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        # A fresh clone has no config.json. Seeding one from the example means
        # `git clone` + a search works immediately, with Firecrawl's keyless tier
        # live and Exa waiting for a key.
        example = SKILL_DIR / "config.example.json"
        if example.exists():
            try:
                _write_atomic(CONFIG_PATH, example.read_text(encoding="utf-8"))
            except OSError:
                pass
        else:
            _write_atomic(CONFIG_PATH, json.dumps({}, ensure_ascii=False, indent=2))
        print(
            f"[parallel-search] created {CONFIG_PATH} from the example template.\n"
            f"  Running with Firecrawl's keyless tier.\n"
            f"  To add keys: python {Path(__file__).name} --setup "
            f"--exa-key '...' --tavily-key '...' --zhihu-secret '...'\n"
            f"  Exa is the primary backend and needs a key: https://dashboard.exa.ai",
            file=sys.stderr,
        )
    cfg = _read_json(CONFIG_PATH, {})
    if not isinstance(cfg, dict):
        sys.exit(f"[parallel-search] config.json is not a JSON object: {CONFIG_PATH}")
    return cfg


def _env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return ""


def _credentials(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Config values win; env vars are the fallback for keys kept out of files."""
    exa = [k for k in (cfg.get("exa_keys") or []) if isinstance(k, str) and k.strip()]
    exa_env = _env("EXA_API_KEY", "PARALLEL_SEARCH_EXA_KEY")
    if exa_env and exa_env not in exa:
        exa.append(exa_env)

    fc = [k for k in (cfg.get("firecrawl_keys") or []) if isinstance(k, str)]
    fc_env = _env("FIRECRAWL_API_KEY", "PARALLEL_SEARCH_FIRECRAWL_KEY")
    if fc_env and fc_env not in fc:
        fc.append(fc_env)
    if not fc:
        # Keyless tier: 1000 free credits/month, no account, bare REST works.
        fc = [""]

    tv = [k for k in (cfg.get("tavily_keys") or []) if isinstance(k, str)]
    tv_env = _env("TAVILY_API_KEY", "PARALLEL_SEARCH_TAVILY_KEY")
    if tv_env and tv_env not in tv:
        tv.append(tv_env)

    return {
        "exa_keys": exa,
        "firecrawl_keys": fc,
        "tavily_keys": tv,
        "yuanbao_api_key": (
            str(cfg.get("yuanbao_api_key") or "").strip()
            or _env("YUANBAO_SEARCH_API_KEY", "TENCENTCLOUD_WSA_APIKEY",
                    "PARALLEL_SEARCH_YUANBAO_KEY")
        ),
        "zhihu_access_secret": (
            cfg.get("zhihu_access_secret")
            or _env("ZHIHU_ACCESS_SECRET", "PARALLEL_SEARCH_ZHIHU_SECRET")
            or ""
        ),
        "global_access_secret": (
            cfg.get("global_access_secret")
            or _env("GLOBAL_ACCESS_SECRET", "PARALLEL_SEARCH_GLOBAL_SECRET")
            or ""
        ),
    }


def _enabled(name: str, cfg: Dict[str, Any], default: bool = True) -> bool:
    disabled = cfg.get("disabled_backends") or []
    enabled = cfg.get("enabled_backends")
    if enabled and name not in enabled:
        return False
    return name not in disabled and default


# ---------------------------------------------------------------------------
# Cooldowns
# ---------------------------------------------------------------------------
def load_cooldowns() -> Dict[str, float]:
    raw = _read_json(COOLDOWN_PATH, {})
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k, v in raw.items():
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def on_cooldown(tool_id: str, cooldowns: Dict[str, float]) -> Tuple[bool, Optional[float]]:
    until = cooldowns.get(tool_id)
    if until is None or time.time() >= until:
        return False, None
    return True, until


def apply_cooldown(tool_id: str, cooldowns: Dict[str, float], seconds: int) -> None:
    cooldowns[tool_id] = time.time() + seconds


# ---------------------------------------------------------------------------
# Yuanbao monthly free-tier quota (local hard cap)
# ---------------------------------------------------------------------------
def _quota_period() -> str:
    """Billing month as the provider sees it (calendar month, local time)."""
    return datetime.now().strftime("%Y-%m")


def load_yuanbao_quota() -> Dict[str, Any]:
    """Read this month's counter, rolling over on the 1st.

    Only the current month is kept: last month's number is neither billable nor
    interesting, and retaining it invites off-by-one confusion at rollover.
    """
    period = _quota_period()
    raw = _read_json(YUANBAO_QUOTA_PATH, {})
    if not isinstance(raw, dict) or str(raw.get("period") or "") != period:
        return {"period": period, "used": 0}
    try:
        used = int(raw.get("used") or 0)
    except (TypeError, ValueError):
        used = 0
    return {"period": period, "used": max(0, used)}


def save_yuanbao_quota(used: int, period: str = "") -> None:
    try:
        _write_atomic(YUANBAO_QUOTA_PATH, json.dumps({
            "period": period or _quota_period(),
            "used": max(0, int(used)),
            "updated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        }, ensure_ascii=False, indent=2))
    except OSError:
        pass  # a read-only state dir must not break searching


def resolve_yuanbao_limit(cfg: Optional[Dict[str, Any]] = None) -> int:
    """Hard ceiling for the month. Never above the documented free allowance.

    Capping *below* 2000 is allowed (a safety margin); going above it is not —
    the whole point is that the free tier is the ceiling.
    """
    raw = (cfg or {}).get("yuanbao_monthly_limit", YUANBAO_FREE_CALLS_PER_MONTH)
    try:
        want = int(raw)
    except (TypeError, ValueError):
        want = YUANBAO_FREE_CALLS_PER_MONTH
    return max(1, min(want, YUANBAO_FREE_CALLS_PER_MONTH))


def reserve_yuanbao_call(limit: int) -> Tuple[bool, Dict[str, Any]]:
    """Claim one call *before* sending it. Returns (allowed, snapshot).

    Charging up front rather than on success is deliberate: a crash between
    "sent" and "counted" would let the counter drift below reality, and every
    drifting call is money. Erring one call short is the cheap direction.
    """
    limit = max(1, int(limit or YUANBAO_FREE_CALLS_PER_MONTH))
    q = load_yuanbao_quota()
    if q["used"] >= limit:
        return False, {"period": q["period"], "used": q["used"], "limit": limit,
                       "remaining": 0, "exhausted": True}
    used = q["used"] + 1
    save_yuanbao_quota(used, q["period"])
    return True, {"period": q["period"], "used": used, "limit": limit,
                  "remaining": limit - used, "exhausted": used >= limit}


def refund_yuanbao_call() -> None:
    """Give back a reservation whose request was refused before any search ran.

    Only used for errors that mean "the provider did not process this request"
    (bad key, service not activated, rejected parameters). Timeouts and 5xx are
    *not* refunded: the request may well have been served and billed.
    """
    q = load_yuanbao_quota()
    save_yuanbao_quota(max(0, q["used"] - 1), q["period"])


def yuanbao_quota_snapshot(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Used/limit/remaining for reporting. Does not consume anything."""
    q = load_yuanbao_quota()
    limit = resolve_yuanbao_limit(cfg)
    return {"period": q["period"], "used": q["used"], "limit": limit,
            "remaining": max(0, limit - q["used"]),
            "exhausted": q["used"] >= limit}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def _parse_body(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _request(
    url: str,
    headers: Dict[str, str],
    body: Optional[Dict[str, Any]] = None,
    method: str = "POST",
    timeout: int = HTTP_TIMEOUT,
) -> Tuple[int, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    hdrs = {**headers, "Content-Type": "application/json"}
    if data is not None:
        hdrs["Content-Type"] = "application/json; charset=utf-8"
    req = Request(url, data=data, method=method, headers=hdrs)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, _parse_body(resp.read().decode("utf-8", errors="replace"))
    except HTTPError as e:
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - body already consumed / unavailable
            raw = ""
        retry_after = e.headers.get("Retry-After") if e.headers else None
        body_obj: Any = _parse_body(raw) if raw else ""
        if isinstance(body_obj, dict):
            body_obj.setdefault("_retry_after", retry_after)
        return e.code, body_obj
    except (URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def _retry_after_seconds(body: Any, default: int) -> int:
    if isinstance(body, dict):
        ra = body.get("_retry_after")
        try:
            if ra:
                return max(default, int(float(ra)))
        except (TypeError, ValueError):
            pass
    return default


def plan_fetch(top_k: int, provider: str, mode: str = COST_MODE) -> int:
    """How many results to ask a paid provider for, given what the caller wants.

    ``top_k`` is what survives ranking. We fetch a small multiple of it because
    duplicates and off-target rows get dropped, but a fixed large page would pay
    for results nobody will read.
    """
    factors = FETCH_FACTORS.get(mode, FETCH_FACTORS["balanced"])
    factor = factors.get(provider, 2.0)
    ceiling = PROVIDER_CEILINGS.get(provider, 100)
    want = int(math.ceil(max(1, top_k) * factor))
    return max(MIN_FETCH, min(want, ceiling))


def resolve_mode(cfg: Dict[str, Any], override: Optional[str] = None) -> str:
    """CLI flag wins, then config, then the default. Unknown values fall back."""
    mode = str(override or cfg.get("cost_mode") or COST_MODE)
    return mode if mode in FETCH_FACTORS else COST_MODE


def resolve_fetch(provider: str, cfg: Dict[str, Any], top_k: int,
                  mode: str = COST_MODE, *, keyed: bool = True) -> int:
    """How many results this run will actually ask ``provider`` for.

    Deliberately the single source of truth: ``build_tasks`` and ``estimate_cost``
    both read it, so a quote cannot drift from what gets sent.
    """
    if provider == "tavily":
        # Billed per call, not per result: 20 results cost exactly what 5 cost.
        # Deriving it from top_k would only throw away free recall.
        return TAVILY_MAX_RESULTS
    if provider == "exa":
        pinned = cfg.get("exa_num_results")
        if pinned:
            return max(1, min(int(pinned), EXA_MAX_RESULTS))
        return plan_fetch(top_k, "exa", mode)
    if provider == "firecrawl" and not keyed:
        return min(plan_fetch(top_k, "firecrawl", mode), FIRECRAWL_LIMIT_KEYLESS)
    if provider == "yuanbao":
        # Per-call billing + enum page sizes: resolve straight onto a legal step
        # so the quote and the request can never disagree about `Cnt`.
        return _snap_yuanbao_cnt(plan_fetch(top_k, "yuanbao", mode))
    return plan_fetch(top_k, provider, mode)


def estimate_cost(top_k: int, cfg: Dict[str, Any], mode: str = COST_MODE) -> Dict[str, Any]:
    """Predict spend before spending it. Rates are the published ones."""
    creds = _credentials(cfg)
    plan: Dict[str, Dict[str, Any]] = {}
    free: List[Dict[str, Any]] = []

    if _enabled("exa", cfg):
        keys = [k for k in creds["exa_keys"] if k]
        if keys:
            n = resolve_fetch("exa", cfg, top_k, mode)
            # base $7/1k covers the first 10 results; extra results are $1/1k
            per_call = 0.007 + max(0, n - EXA_BASE_RESULTS) * 0.001
            plan["exa"] = {"fetch": n, "calls": len(keys),
                           "est_usd": round(per_call * len(keys), 4)}

    if _enabled("firecrawl", cfg):
        keys = [k for k in creds["firecrawl_keys"] if k]
        n = resolve_fetch("firecrawl", cfg, top_k, mode, keyed=bool(keys))
        per_call = n / 10 * FIRECRAWL_COST_ESTIMATE_PER_10
        plan["firecrawl"] = {"fetch": n, "calls": max(1, len(keys)),
                             "tier": "keyed" if keys else "keyless",
                             "est_credits": round(per_call * max(1, len(keys)), 1)}

    if _enabled("firecrawl_news", cfg) and cfg.get("news_backends") \
            and [k for k in creds["firecrawl_keys"] if k]:
        n = resolve_fetch("firecrawl", cfg, top_k, mode)
        plan["firecrawl_news"] = {"fetch": n, "calls": 1,
                                  "est_credits": round(n / 10 * FIRECRAWL_COST_ESTIMATE_PER_10, 1)}

    if _enabled("tavily", cfg):
        tv_keys = [k for k in creds["tavily_keys"] if k]
        if tv_keys:
            plan["tavily"] = {"fetch": TAVILY_MAX_RESULTS, "calls": len(tv_keys),
                              "est_credits": len(tv_keys)}  # flat 1 credit per call

    if _enabled("yuanbao", cfg) and creds["yuanbao_api_key"]:
        # Billed per call in CNY, with the first 2000 calls of each calendar
        # month free — so the honest number for a personal run is 0. The local
        # counter is what keeps it at 0.
        q = load_yuanbao_quota()
        limit = resolve_yuanbao_limit(cfg)
        plan["yuanbao"] = {
            "fetch": resolve_fetch("yuanbao", cfg, top_k, mode),
            "calls": 1,
            "mode": YUANBAO_MODES.get(int(cfg.get("yuanbao_mode", 2) or 0), "mixed"),
            "list_cny": YUANBAO_CNY_PER_CALL,
            "free_quota": f"{YUANBAO_FREE_CALLS_PER_MONTH}/month",
            "quota_period": q["period"],
            "quota_used": q["used"],
            "quota_limit": limit,
            "quota_remaining": max(0, limit - q["used"]),
        }

    for name, count in (("zhihu", ZHIHU_COUNT), ("global", GLOBAL_COUNT)):
        if _enabled(name, cfg) and creds[f"{name}_access_secret"]:
            free.append({"backend": name, "fetch": count})

    return {
        "top_k": top_k,
        "mode": mode,
        "plan": plan,
        "free_backends": free,
        "est_usd_total": round(sum(v.get("est_usd", 0) for v in plan.values()), 4),
        "est_cny_total": round(sum(v.get("list_cny", 0) for v in plan.values()), 2),
        "est_credits_total": round(sum(v.get("est_credits", 0) for v in plan.values()), 1),
    }


def call_with_retry(tool_id: str, fn: Callable, attempts: int = 2) -> Dict[str, Any]:
    """Retry once on transport failures only.

    Observed in practice: a single backend intermittently times out on a
    healthy connection, which would otherwise silently shrink the result set.
    Only status 0 (network/timeout) is retried — retrying a quota or auth
    rejection just burns time and, for rate-limited APIs, makes things worse.
    """
    last = _fail(tool_id, "error", error="no attempt made")
    for i in range(max(1, attempts)):
        last = fn()
        if last.get("status") != "network":
            return last
        if i + 1 < attempts:
            time.sleep(1.5)
    return last


# ---------------------------------------------------------------------------
# Result shaping
# ---------------------------------------------------------------------------
def _make_item(title: str, url: str, snippet: str, source: str,
               rank: int, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    item = {
        "title": (title or "").strip()[:300],
        "url": (url or "").strip(),
        "snippet": (snippet or "").strip()[:800],
        "source": source,
        "rank": rank,
        "host": _host_of(url),
    }
    if extra:
        for k, v in extra.items():
            if v not in (None, "", [], {}):
                item[k] = v
    return item


def _fail(tool_id: str, status: str, **kw: Any) -> Dict[str, Any]:
    out = {"tool": tool_id, "status": status, "results": []}
    out.update(kw)
    return out


def _looks_like_ip_block(body: Any) -> bool:
    """Detect 'your IP looks like a VPN/proxy' style refusals.

    Firecrawl returns 403 (not 401) when its keyless tier refuses an IP it
    considers suspicious. That is an *environment* condition, not a bad
    credential: cooling it down as `auth` would mislabel the cause and hide the
    fact that an API key would fix it.
    """
    text = _truncate(body, 600).lower()
    markers = ("looks like a vpn", "looks suspicious", "vpn or proxy",
               "proxy, so", "can't be used without an api key",
               "ip address")
    return any(m in text for m in markers)


def _classify_http(status: int, body: Any, tool_id: str,
                   plan_cap_seconds: int = COOLDOWN_SECONDS_PLAN_CAP) -> Dict[str, Any]:
    """Map an HTTP status onto the internal status vocabulary."""
    if status == 403 and _looks_like_ip_block(body):
        return _fail(tool_id, "ip_blocked", http_status=status, reason="ip_blocked",
                     error=_truncate(body), cooldown_seconds=COOLDOWN_SECONDS_IP_BLOCK)
    if status in (401, 403):
        return _fail(tool_id, "auth", http_status=status,
                     error=_truncate(body), cooldown_seconds=COOLDOWN_SECONDS_AUTH)
    if status in (402, 432, 433):
        # 402/432/433 = money problems. Retry-in-an-hour would just burn calls.
        return _fail(tool_id, "quota", http_status=status, reason="plan_cap",
                     error=_truncate(body), cooldown_seconds=plan_cap_seconds)
    if status == 429:
        return _fail(tool_id, "rate_limited", http_status=status,
                     error=_truncate(body),
                     cooldown_seconds=_retry_after_seconds(body, COOLDOWN_SECONDS_DEFAULT))
    if status == 0:
        return _fail(tool_id, "network", error=_truncate(body))
    return _fail(tool_id, "error", http_status=status, error=_truncate(body))


# ---------------------------------------------------------------------------
# Backend: Firecrawl
# ---------------------------------------------------------------------------
def search_firecrawl(query: str, api_key: str, idx: int, *, news: bool = False,
                     limit: Optional[int] = None) -> Dict[str, Any]:
    tool_id = "firecrawl_news" if news else f"firecrawl:{idx + 1}"
    keyed = bool(api_key)
    ceiling = FIRECRAWL_LIMIT_KEYED if keyed else FIRECRAWL_LIMIT_KEYLESS
    limit = ceiling if limit is None else max(1, min(int(limit), ceiling))
    sources = ["news"] if news else ["web"]

    headers = {"Authorization": f"Bearer {api_key}"} if keyed else {}
    status, body = _request(FIRECRAWL_ENDPOINT, headers, {
        "query": query,
        "limit": limit,
        "sources": sources,
        "timeout": 30000,
    })
    if status != 200:
        return _classify_http(status, body, tool_id)

    if not isinstance(body, dict) or not body.get("success"):
        # keyless tier can be refused from a flagged IP even on HTTP 200
        text = _truncate(body).lower()
        reason = ("keyless_ip_blocked"
                  if "suspicious" in text or "api key" in text else "bad_response")
        return _fail(tool_id, "skipped", reason=reason, error=_truncate(body))

    web = _dig(body, "data.web") or _dig(body, "data.news") or []
    items = []
    for i, it in enumerate(web):
        if not isinstance(it, dict):
            continue
        url = it.get("url") or ""
        if not url:
            continue
        snippet = it.get("description") or ""
        if not snippet:
            md = it.get("markdown") or ""
            snippet = md[:500] if isinstance(md, str) else ""
        items.append(_make_item(it.get("title", ""), url, snippet, tool_id, i,
                                {"published": it.get("publishedDate") or it.get("published_date")}))
    out = {"tool": tool_id, "status": "ok", "results": items, "keyed": keyed,
           "credits_used": body.get("creditsUsed")}
    if body.get("warning"):
        out["warning"] = _truncate(body["warning"], 200)
    return out


# ---------------------------------------------------------------------------
# Backend: Exa (primary)
# ---------------------------------------------------------------------------
def search_exa(query: str, api_key: str, idx: int, *, search_type: str = "auto",
               num_results: int = EXA_BASE_RESULTS,
               category: str = "", start_date: str = "", end_date: str = "",
               include_domains: Optional[Sequence[str]] = None,
               exclude_domains: Optional[Sequence[str]] = None,
               text: bool = False) -> Dict[str, Any]:
    """Exa neural search — the default primary backend.

    ``type`` maps to Exa's search modes. ``auto`` lets Exa choose; the deep-*
    variants cost more and take longer (4-40s), so they are opt-in via config.
    ``contents.text`` is off by default: full page text is billed per page and
    the ranker only needs a snippet.
    """
    tool_id = f"exa:{idx + 1}"
    if not api_key:
        return _fail(tool_id, "skipped", reason="no_key")

    if search_type not in EXA_TYPES:
        search_type = "auto"
    num_results = max(1, min(int(num_results or EXA_BASE_RESULTS), EXA_MAX_RESULTS))

    payload: Dict[str, Any] = {
        "query": query,
        "type": search_type,
        "numResults": num_results,
        "contents": {"text": True} if text else {"highlights": True},
    }
    if category:
        payload["category"] = category
    if start_date:
        payload["startPublishedDate"] = start_date
    if end_date:
        payload["endPublishedDate"] = end_date
    if include_domains:
        payload["includeDomains"] = list(include_domains)
    if exclude_domains:
        payload["excludeDomains"] = list(exclude_domains)

    status, body = _request(EXA_ENDPOINT, {"x-api-key": api_key}, payload)

    if status != 200:
        # 402 = out of credits / key budget (docs). A day-long cooldown is right:
        # billing recovers on the monthly reset, not on an hourly retry.
        return _classify_http(status, body, tool_id)

    items = []
    for i, it in enumerate(body.get("results") or [] if isinstance(body, dict) else []):
        if not isinstance(it, dict) or not it.get("url"):
            continue
        # Prefer highlights (query-relevant excerpts); fall back to full text.
        hl = it.get("highlights") or []
        if isinstance(hl, list) and hl:
            snippet = " […] ".join(str(h) for h in hl[:3] if h)
        else:
            snippet = it.get("summary") or it.get("text") or ""
        items.append(_make_item(it.get("title", ""), it["url"], snippet, tool_id, i,
                                {"published": it.get("publishedDate"),
                                 "author": it.get("author"),
                                 "score": it.get("score")}))

    out: Dict[str, Any] = {"tool": tool_id, "status": "ok", "results": items,
                           "search_type": search_type}
    if isinstance(body, dict):
        cost = body.get("costDollars")
        if isinstance(cost, dict) and cost.get("total"):
            out["cost_usd"] = cost.get("total")
    return out


# ---------------------------------------------------------------------------
# Backend: Tavily
# ---------------------------------------------------------------------------
def search_tavily(query: str, api_key: str, idx: int, *,
                   topic: str = "general", days: Optional[int] = None) -> Dict[str, Any]:
    tool_id = f"tavily:{idx + 1}"
    if not api_key:
        return _fail(tool_id, "skipped", reason="no_key")

    payload: Dict[str, Any] = {
        "query": query,
        "max_results": TAVILY_MAX_RESULTS,
        "search_depth": "basic",
        "include_answer": False,
        "include_raw_content": False,
        "include_published_date": True,
    }
    if topic and topic != "general":
        payload["topic"] = topic
    if days:
        payload["days"] = int(days)

    status, body = _request(TAVILY_ENDPOINT, {"Authorization": f"Bearer {api_key}"}, payload)
    if status != 200:
        return _classify_http(status, body, tool_id)

    items = []
    for i, it in enumerate(body.get("results") or [] if isinstance(body, dict) else []):
        if not isinstance(it, dict) or not it.get("url"):
            continue
        items.append(_make_item(it.get("title", ""), it["url"], it.get("content", ""),
                                tool_id, i, {"published": it.get("published_date"),
                                             "score": it.get("score")}))
    return {"tool": tool_id, "status": "ok", "results": items}


# ---------------------------------------------------------------------------
# Backend: Tencent Yuanbao Search (元宝搜索)
# ---------------------------------------------------------------------------
def _snap_yuanbao_cnt(n: Any) -> int:
    """``Cnt`` is an enum (10/20/30/40/50), not a range — anything else 400s.

    Round UP rather than down: billing is per *call*, so a wider page costs the
    same and rounding down would only throw recall away.
    """
    try:
        want = int(n)
    except (TypeError, ValueError):
        want = YUANBAO_CNT_STEPS[0]
    for step in YUANBAO_CNT_STEPS:
        if want <= step:
            return step
    return YUANBAO_MAX_CNT


def _norm_published(v: Any) -> str:
    """Normalise Yuanbao's ``date`` ('2025/02/26 09:37:00', '2024-06-07 19:00:51')
    to ISO-8601 so date-aware consumers do not have to branch on the separator."""
    if not v:
        return ""
    s = str(v).strip().replace("/", "-")
    m = re.match(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$", s)
    if m:
        return f"{m.group(1)}T{m.group(2)}" if m.group(2) else m.group(1)
    return s[:32]


def _yuanbao_error(body: Any, tool_id: str,
                   http_status: int = 0) -> Optional[Dict[str, Any]]:
    """Translate a Tencent Cloud error envelope into the internal vocabulary.

    A service that was never activated and a key that is simply wrong both look
    like "it did not work", but only one of them is fixed by editing
    config.json — keeping them apart is what makes ``--check`` actionable.
    """
    if not isinstance(body, dict):
        return None
    err = _dig(body, "Response.Error")
    if not isinstance(err, dict):
        return None
    code = str(err.get("Code") or "UnknownError")
    msg = str(err.get("Message") or "")
    base: Dict[str, Any] = {"http_status": http_status or 200, "tb_code": code,
                            "error": _truncate(msg or code, 300)}
    if code.startswith("AuthFailure") or code in ("UnauthorizedOperation",
                                                  "InvalidCredential"):
        return _fail(tool_id, "auth", reason="auth_failed",
                     cooldown_seconds=COOLDOWN_SECONDS_AUTH, **base)
    if code == "RequestLimitExceeded":
        return _fail(tool_id, "rate_limited", reason="rate_limited",
                     cooldown_seconds=COOLDOWN_SECONDS_DEFAULT, **base)
    if code.startswith("ResourceUnavailable"):
        # arrears / suspended service: a billing event, not a bug
        return _fail(tool_id, "quota", reason="plan_cap",
                     cooldown_seconds=COOLDOWN_SECONDS_PLAN_CAP, **base)
    if code == "ResourceNotFound":
        # The product was never opened on this account. No cooldown on purpose:
        # the fix is a console click, and the very next run should succeed.
        return _fail(tool_id, "skipped", reason="service_not_opened", **base)
    return _fail(tool_id, "error", reason=code, **base)


def search_yuanbao(query: str, api_key: str, *, tool_id: str = "yuanbao",
                   mode: Optional[int] = 2, cnt: Any = YUANBAO_CNT_STEPS[1],
                   site: str = "", industry: str = "", freshness: str = "",
                   deeplinks: bool = False, monthly_limit: int = YUANBAO_FREE_CALLS_PER_MONTH,
                   _degrade: bool = True) -> Dict[str, Any]:
    """元宝搜索 ``SearchPro`` — the CN-first secondary source.

    What it buys the fan-out that the other backends cannot: 157 curated
    authoritative vertical sources (policy/news/academic/finance), minute-level
    freshness, and an LLM reranker that carries an ``authority_level`` on the
    flagship tier. Billing is per call, so ``Cnt`` is always filled generously.

    ``mode``: 0 = public web, 1 = authoritative verticals, 2 = mixed (default).
    ``None`` omits the field entirely — the lite tier rejects ``Mode``/``Cnt``,
    which is what the one-shot degrade path below is for.

    ``monthly_limit`` is a hard local stop at the free allowance. Calls past it
    are never sent, because a call over the free tier becomes an invoice.
    """
    if not api_key:
        return _fail(tool_id, "skipped", reason="no_key")

    allowed, quota = reserve_yuanbao_call(monthly_limit)
    if not allowed:
        # Refused before the request went out, so nothing to refund. The whole
        # point is that this branch never spends money.
        return _fail(tool_id, "skipped", reason="free_quota_exhausted", quota=quota)

    payload: Dict[str, Any] = {"Query": query}
    if mode is not None:
        try:
            m = int(mode)
        except (TypeError, ValueError):
            m = 2
        if m in YUANBAO_MODES:
            payload["Mode"] = m
    if cnt:
        payload["Cnt"] = _snap_yuanbao_cnt(cnt)
    if site:
        payload["Site"] = str(site)
    if industry and str(industry) in YUANBAO_INDUSTRIES:
        payload["Industry"] = str(industry)
    if freshness and YUANBAO_FRESHNESS_RE.match(str(freshness)):
        payload["Freshness"] = str(freshness)
    if deeplinks and "Mode" in payload:
        payload["Deeplinks"] = True

    status, body = _request(YUANBAO_ENDPOINT,
                            {"Authorization": f"Bearer {api_key}"}, payload)

    def _unserved(err: Dict[str, Any]) -> bool:
        """True when the provider clearly did not process the request.

        Only those cases give the reservation back. A timeout, a 5xx or a
        rate-limit may well have been served and billed upstream, so those
        keep the charge — this is the direction that cannot overspend.
        """
        return (err.get("status") == "auth"
                or err.get("reason") == "service_not_opened"
                or str(err.get("tb_code") or "") == "InvalidParameter")

    if status != 200:
        err = _yuanbao_error(body, tool_id, status)
        if err is None:
            err = _classify_http(status, body, tool_id)
        if _unserved(err):
            refund_yuanbao_call()
        return err

    resp = _dig(body, "Response")
    if not isinstance(resp, dict):
        return _fail(tool_id, "error", http_status=200,
                     error="missing Response envelope: " + _truncate(body, 200))

    err = _yuanbao_error(body, tool_id, 200)
    if err:
        # The lite (极速版) tier documents Mode/Cnt/Deeplinks as unsupported and
        # answers InvalidParameter when they are sent. Retry once with the bare
        # minimum instead of failing the source for the whole run. Only a
        # parameter rejection triggers this, so auth/quota problems are never
        # masked by it.
        if (_degrade and err.get("tb_code") == "InvalidParameter"
                and any(k in payload for k in ("Mode", "Cnt", "Deeplinks"))):
            if _unserved(err):
                refund_yuanbao_call()
            retry = search_yuanbao(query, api_key, tool_id=tool_id, mode=None,
                                   cnt=0, site="", industry=industry,
                                   freshness=freshness, deeplinks=False,
                                   monthly_limit=monthly_limit, _degrade=False)
            if retry.get("status") == "ok":
                retry["degraded"] = "lite_tier_stripped_mode_cms"
            return retry
        if _unserved(err):
            refund_yuanbao_call()
        return err

    items = []
    for i, raw in enumerate(resp.get("Pages") or []):
        page: Any = raw
        if isinstance(raw, str):
            # Pages is an array of *JSON strings*, not objects — the single most
            # common integration bug with this API.
            try:
                page = json.loads(raw)
            except (ValueError, TypeError):
                page = None
        if not isinstance(page, dict) or not page.get("url"):
            continue
        snippet = page.get("content") or page.get("passage") or ""
        if not isinstance(snippet, str):
            snippet = _truncate(snippet, 500)
        items.append(_make_item(
            page.get("title", ""), page["url"], snippet, tool_id, i,
            {"published": _norm_published(page.get("date")),
             "site_name": page.get("site"),
             "authority": page.get("authority_level")}))

    out: Dict[str, Any] = {
        "tool": tool_id, "status": "ok", "results": items,
        "result_mode": YUANBAO_MODES.get(payload.get("Mode"), "default"),
        "cnt": payload.get("Cnt"),
        "tier": resp.get("Version") or "",
        "quota": quota,
    }
    if resp.get("Msg"):
        out["warning"] = _truncate(resp["Msg"], 200)
    return out


# ---------------------------------------------------------------------------
# Backend: Zhihu (business-code protocol)
# ---------------------------------------------------------------------------
def _zhihu_search(query: str, secret: str, tool_id: str, endpoint: str,
                  count: int, cfg_filter: str = "", search_db: str = "") -> Dict[str, Any]:
    if not secret:
        return _fail(tool_id, "skipped", reason="no_key")

    params: Dict[str, str] = {"Query": query, "Count": str(count)}
    if cfg_filter:
        params["Filter"] = cfg_filter
    if search_db:
        params["SearchDB"] = search_db
    url = f"{endpoint}?{urlencode(params)}"

    status, body = _request(url, {
        "Authorization": f"Bearer {secret}",
        "X-Request-Timestamp": str(int(time.time())),
    }, method="GET")

    if status != 200:
        return _classify_http(status, body, tool_id)

    # HTTP 200 does not mean success: Code==0 does.
    if not isinstance(body, dict):
        return _fail(tool_id, "error", http_status=200, error="non-json body")
    code = body.get("Code")
    if code != ZHIHU_OK:
        reason = ZHIHU_CODES.get(code, f"code_{code}")
        if code == 20001:
            return _fail(tool_id, "auth", http_status=200, zhihu_code=code,
                         reason=reason, error=_truncate(body.get("Message") or body),
                         cooldown_seconds=COOLDOWN_SECONDS_AUTH)
        if code == 30001:
            return _fail(tool_id, "rate_limited", http_status=200, zhihu_code=code,
                         reason=reason, error=_truncate(body.get("Message") or body),
                         cooldown_seconds=COOLDOWN_SECONDS_DEFAULT)
        return _fail(tool_id, "error", http_status=200, zhihu_code=code,
                     reason=reason, error=_truncate(body.get("Message") or body))

    items = []
    for i, it in enumerate(_dig(body, "Data.Items") or []):
        if not isinstance(it, dict) or not it.get("Url"):
            continue
        items.append(_make_item(it.get("Title", ""), it["Url"], it.get("ContentText", ""),
                                tool_id, i,
                                {"published_ts": it.get("EditTime"),
                                 "votes": it.get("VoteUpCount"),
                                 "comments": it.get("CommentCount"),
                                 "author": it.get("AuthorName")}))
    return {"tool": tool_id, "status": "ok", "results": items,
            "has_more": bool(_dig(body, "Data.HasMore"))}


# ---------------------------------------------------------------------------
# Backend: generic HTTP API (config-driven, no code change needed)
# ---------------------------------------------------------------------------
def search_http_source(query: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    sid = str(spec.get("id") or "http")
    tool_id = f"http:{sid}"
    url_tpl = spec.get("url")
    if not url_tpl:
        return _fail(tool_id, "error", reason="bad_spec", error="missing url")

    url = url_tpl.replace("{query}", quote(query, safe=""))
    for k, v in (spec.get("url_params") or {}).items():
        url += ("&" if "?" in url else "?") + urlencode({k: str(v).replace("{query}", query)})

    headers = dict(spec.get("headers") or {})
    secret_env = spec.get("secret_env")
    if secret_env:
        val = _env(secret_env)
        if not val:
            return _fail(tool_id, "skipped", reason="no_secret", secret_env=secret_env)
        tmpl = spec.get("auth_header") or "Bearer {secret}"
        headers["Authorization"] = tmpl.format(secret=val)

    method = str(spec.get("method") or "GET").upper()
    body_spec = spec.get("body")
    payload = None
    if body_spec:
        payload = json.loads(json.dumps(body_spec).replace("{query}", query)) \
            if isinstance(body_spec, (dict, list)) else {"query": query}

    status, body = _request(url, headers, payload, method=method,
                            timeout=int(spec.get("timeout", HTTP_TIMEOUT)))
    if status != 200:
        return _classify_http(status, body, tool_id)

    rows = _dig(body, str(spec.get("results_path") or "results"))
    if not isinstance(rows, list):
        rows = [body] if isinstance(body, dict) else []
    fmap = spec.get("fields") or {}

    items = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        url_val = ""
        for cand in (fmap.get("url", "url"), "url", "link"):
            if isinstance(row.get(cand), str) and row.get(cand):
                url_val = row[cand]
                break
        if not url_val:
            continue
        title = _dig(row, fmap.get("title", "title")) or ""
        snippet = _dig(row, fmap.get("snippet", "description")) or ""
        if not isinstance(snippet, str):
            snippet = _truncate(snippet, 500)
        items.append(_make_item(str(title), url_val, snippet, tool_id, i))

    out: Dict[str, Any] = {"tool": tool_id, "status": "ok", "results": items}
    if spec.get("weight"):
        out["weight"] = float(spec["weight"])
    return out


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------
def score_and_merge(per_tool: Dict[str, Dict[str, Any]], query: str,
                    weights: Dict[str, float]) -> List[Dict[str, Any]]:
    """Dedupe by canonical URL and score every survivor."""
    terms = query_terms(query)
    buckets: Dict[str, Dict[str, Any]] = {}

    for tool_id, res in per_tool.items():
        if res.get("status") != "ok":
            continue
        base = res.get("weight", SOURCE_WEIGHTS.get(tool_id.split(":")[0], 0.85))
        for item in res.get("results", []):
            url = item.get("url") or ""
            if not url:
                continue
            key = _canonical_url(url)
            if not key:
                continue
            b = buckets.get(key)
            if b is None:
                b = {"item": dict(item), "sources": [], "best_rank": item.get("rank", 99),
                     "base": base, "extra": 0.0}
                buckets[key] = b
            b["sources"].append(tool_id)
            b["best_rank"] = min(b["best_rank"], item.get("rank", 99))
            b["base"] = max(b["base"], base)
            # keep the richest snippet we saw for this URL
            if len(item.get("snippet", "")) > len(b["item"].get("snippet", "")):
                b["item"]["snippet"] = item["snippet"]
            if not b["item"].get("title") and item.get("title"):
                b["item"]["title"] = item["title"]

    # Consensus measures *independent* evidence. Two keys of one service return
    # the same page for the same reason, so `exa:1` + `exa:2` is one source, not
    # two -- otherwise a second key would buy every one of its rows a ranking
    # bonus for agreeing with itself.
    def families(sources: Iterable[str]) -> int:
        return len({t.split(":")[0] for t in sources})

    max_sources = max((families(b["sources"]) for b in buckets.values()), default=1) or 1
    out: List[Dict[str, Any]] = []
    q_lower = _norm(query)

    for b in buckets.values():
        it = b["item"]
        text = _norm(f"{it.get('title', '')} {it.get('snippet', '')}")
        title_n = _norm(it.get("title", ""))

        # 1. term coverage over title + snippet
        hits = sum(1 for t in terms if t in text)
        coverage = hits / len(terms) if terms else 0.0
        # 2. title-only coverage — a strong signal, weighted higher
        t_hits = sum(1 for t in terms if t in title_n)
        title_cov = t_hits / len(terms) if terms else 0.0
        # 3. within-backend rank (1 at the top)
        rank_score = 1.0 / (1.0 + math.log2(1 + max(0, b["best_rank"])))
        # 4. cross-source consensus
        consensus = families(b["sources"]) / max_sources

        score = (
            0.42 * coverage
            + 0.20 * title_cov
            + 0.18 * rank_score
            + 0.20 * consensus
        ) * b["base"]

        # small bonuses
        if q_lower and q_lower in _norm(it.get("title", "")):
            score += 0.05
        if it.get("votes"):
            try:
                score += min(0.05, math.log10(1 + int(it["votes"])) * 0.02)
            except (TypeError, ValueError):
                pass
        # very thin snippets are usually nav pages / stubs
        if len(it.get("snippet", "")) < 60:
            score -= 0.03

        it["score"] = round(score, 4)
        it["sources"] = b["sources"]
        out.append(it)

    out.sort(key=lambda x: (-x["score"], x.get("rank", 99)))
    return out


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
def _cache_key(query: str, top_k: Optional[int], extra: str = "") -> str:
    raw = f"{query.strip().lower()}|{top_k or ''}|{extra}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def cache_get(key: str, ttl: int) -> Optional[Dict[str, Any]]:
    path = CACHE_DIR / f"{key}.json"
    if not path.exists():
        return None
    try:
        blob = _read_json(path, None)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(blob, dict):
        return None
    if ttl > 0 and time.time() - float(blob.get("ts", 0)) > ttl:
        return None
    return blob.get("payload")


def cache_put(key: str, payload: Dict[str, Any]) -> None:
    try:
        _write_atomic(CACHE_DIR / f"{key}.json",
                      json.dumps({"ts": time.time(), "payload": payload},
                                 ensure_ascii=False))
    except OSError:
        pass  # cache is best-effort; never fail a search because of it


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
def build_tasks(cfg: Dict[str, Any], creds: Dict[str, Any], query: str,
                cooldowns: Dict[str, float], top_k: int = DEFAULT_TOP_K,
                mode: str = COST_MODE
                ) -> Tuple[List[Tuple[str, Callable, tuple, Dict[str, Any]]], List[Dict[str, Any]]]:
    tasks: List[Tuple[str, Callable, tuple, Dict[str, Any]]] = []
    pre_skipped: List[Dict[str, Any]] = []

    def add(tool_id: str, fn: Callable, args: tuple) -> None:
        add_kw(tool_id, fn, args, {})

    def add_kw(tool_id: str, fn: Callable, args: tuple, kwargs: Dict[str, Any]) -> None:
        cooling, until = on_cooldown(tool_id, cooldowns)
        if cooling:
            pre_skipped.append({"tool": tool_id, "reason": "cooldown", "cooldown_until": until})
        else:
            tasks.append((tool_id, fn, args, kwargs))

    # Exa first — it is the primary backend and defines the fan-out order.
    if _enabled("exa", cfg):
        stype = str(cfg.get("exa_type") or "auto")
        if stype not in EXA_TYPES:
            stype = "auto"
        # Fetch size follows what the caller asked for; an explicit config value
        # wins, so power users can still pin a page size.
        num = resolve_fetch("exa", cfg, top_k, mode)
        exa_common = {
            "search_type": stype,
            "num_results": num,
            "category": str(cfg.get("exa_category") or ""),
            "start_date": str(cfg.get("exa_start_date") or ""),
            "end_date": str(cfg.get("exa_end_date") or ""),
            "include_domains": cfg.get("exa_include_domains") or None,
            "exclude_domains": cfg.get("exa_exclude_domains") or None,
            "text": bool(cfg.get("exa_fetch_text")),
        }
        alt_type = str(cfg.get("exa_secondary_type") or "")
        for i, key in enumerate(creds["exa_keys"]):
            kwargs = dict(exa_common)
            # A second key earns its call by running a *different* retrieval type
            # instead of duplicating the first: same spend, wider net.
            if i and alt_type in EXA_TYPES:
                kwargs["search_type"] = alt_type
            add_kw(f"exa:{i + 1}", search_exa, (query, key, i), kwargs)

    if _enabled("firecrawl", cfg):
        keyed = any(creds["firecrawl_keys"])
        fc_fetch = resolve_fetch("firecrawl", cfg, top_k, mode, keyed=keyed)
        for i, key in enumerate(creds["firecrawl_keys"]):
            add_kw(f"firecrawl:{i + 1}", search_firecrawl, (query, key, i),
                   {"limit": fc_fetch})

    # Everything runs in parallel, so this position is about matching the
    # documented weight order (exa > firecrawl > rest) in --list-backends output,
    # not about who answers first. Registered even without a key on purpose: the
    # function reports `no_key`, which surfaces the missing backend in
    # tools_skipped instead of silently shrinking the fan-out.
    if _enabled("yuanbao", cfg):
        add_kw("yuanbao", search_yuanbao, (query, creds["yuanbao_api_key"]), {
            "mode": cfg.get("yuanbao_mode", 2),
            "cnt": resolve_fetch("yuanbao", cfg, top_k, mode),
            "site": str(cfg.get("yuanbao_site") or ""),
            "industry": str(cfg.get("yuanbao_industry") or ""),
            "freshness": str(cfg.get("yuanbao_freshness") or ""),
            "deeplinks": bool(cfg.get("yuanbao_deeplinks")),
            "monthly_limit": resolve_yuanbao_limit(cfg),
        })

    if _enabled("firecrawl_news", cfg) and cfg.get("news_backends"):
        # Only worth a round-trip when a real key exists — the keyless tier has
        # no news-only guarantee and the credits are better spent on web.
        if any(bool(k) for k in creds["firecrawl_keys"]):
            add_kw("firecrawl_news", search_firecrawl,
                   (query, creds["firecrawl_keys"][0], 0),
                   {"news": True,
                    "limit": resolve_fetch("firecrawl", cfg, top_k, mode)})

    if _enabled("tavily", cfg):
        topic = str(cfg.get("tavily_topic") or "general")
        days = cfg.get("tavily_days")
        for i, key in enumerate(creds["tavily_keys"]):
            add_kw(f"tavily:{i + 1}", search_tavily, (query, key, i),
                   {"topic": topic, "days": int(days) if days else None})

    if _enabled("zhihu", cfg):
        add_kw("zhihu", _zhihu_search,
               (query, creds["zhihu_access_secret"], "zhihu", ZHIHU_ENDPOINT, ZHIHU_COUNT),
               {"cfg_filter": str(cfg.get("zhihu_filter") or ""), "search_db": ""})

    if _enabled("global", cfg):
        add_kw("global", _zhihu_search,
               (query, creds["global_access_secret"], "global", GLOBAL_ENDPOINT, GLOBAL_COUNT),
               {"cfg_filter": "", "search_db": str(cfg.get("global_search_db") or "")})

    if _enabled("http", cfg):
        for spec in (cfg.get("http_sources") or []):
            if isinstance(spec, dict) and spec.get("id"):
                add(f"http:{spec['id']}", search_http_source, (query, spec))

    return tasks, pre_skipped


def run_parallel_search(query: str, cfg: Dict[str, Any], *,
                        top_k: Optional[int] = None,
                        no_cache: bool = False,
                        timeout: int = FUTURE_TIMEOUT,
                        cost_mode: Optional[str] = None) -> Dict[str, Any]:
    creds = _credentials(cfg)
    ttl = int(cfg.get("cache_ttl_seconds", CACHE_TTL_SECONDS))
    mode = resolve_mode(cfg, cost_mode)
    # The key has to cover everything that changes the answer, or a `thorough`
    # run gets served the cached `balanced` page while still reporting its own
    # mode in the output.
    cache_extra = ("|".join(sorted(cfg.get("enabled_backends") or [])) or "default") + f"|{mode}"
    ck = _cache_key(query, top_k, cache_extra)

    if not no_cache and ttl > 0:
        cached = cache_get(ck, ttl)
        if cached:
            # A cache hit spends nothing, but the cached payload carries the
            # spend of the run that produced it. Reporting that would make a
            # free lookup look like it cost money, so zero it and say so.
            cached["cache"] = "hit"
            cached["spend"] = {"exa_usd": 0.0, "firecrawl_credits": 0,
                               "tavily_credits": 0, "yuanbao_calls": 0,
                               "source": "cache"}
            cached.pop("exa_cost_usd", None)
            cached.pop("firecrawl_credits_used", None)
            return cached

    cooldowns = load_cooldowns()
    cooldown_default = int(cfg.get("cooldown_seconds", COOLDOWN_SECONDS_DEFAULT))
    tasks, pre_skipped = build_tasks(cfg, creds, query, cooldowns,
                                     top_k=top_k or DEFAULT_TOP_K, mode=mode)

    per_tool: Dict[str, Dict[str, Any]] = {}
    started = time.time()

    if tasks:
        with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as ex:
            futures = {ex.submit(call_with_retry, tid, lambda f=fn, a=args, k=kw: f(*a, **k)):
                       tid for tid, fn, args, kw in tasks}
            # wait() with a deadline, then harvest — as_completed(timeout=...)
            # raises TimeoutError out of the generator and would kill the run.
            done, not_done = wait(futures, timeout=timeout)
            for fut in done:
                tool_id = futures[fut]
                try:
                    per_tool[tool_id] = fut.result()
                except Exception as e:  # noqa: BLE001
                    per_tool[tool_id] = _fail(tool_id, "error",
                                              error=f"{type(e).__name__}: {e}"[:300])
            for fut in not_done:
                tool_id = futures[fut]
                per_tool[tool_id] = _fail(tool_id, "timeout", reason="deadline_exceeded")
                fut.cancel()

    # Cooldowns for the tools that reported a recoverable failure.
    for tool_id, res in per_tool.items():
        if res.get("status") in ("quota", "rate_limited", "auth", "ip_blocked"):
            secs = int(res.get("cooldown_seconds") or cooldown_default)
            apply_cooldown(tool_id, cooldowns, secs)

    now = time.time()
    cooldowns = {k: v for k, v in cooldowns.items() if v > now}
    try:
        _write_atomic(COOLDOWN_PATH, json.dumps(cooldowns, indent=2, ensure_ascii=False))
    except OSError:
        pass

    merged = score_and_merge(per_tool, query, SOURCE_WEIGHTS)

    used, skipped = [], list(pre_skipped)
    for tool_id, res in sorted(per_tool.items()):
        status = res.get("status")
        if status == "ok" and res.get("results"):
            used.append(tool_id)
        elif status == "ok":
            skipped.append({"tool": tool_id, "reason": "empty"})
        elif status == "timeout":
            skipped.append({"tool": tool_id, "reason": "timeout"})
        elif status in ("quota", "rate_limited", "ip_blocked"):
            skipped.append({"tool": tool_id, "reason": res.get("reason") or status,
                            "http_status": res.get("http_status"),
                            "cooldown_until": cooldowns.get(tool_id)})
        elif status == "auth":
            skipped.append({"tool": tool_id, "reason": res.get("reason") or "auth_failed",
                            "http_status": res.get("http_status"),
                            "cooldown_until": cooldowns.get(tool_id),
                            "hint": "check the key in config.json"})
        else:
            skipped.append({"tool": tool_id, "reason": res.get("reason") or status,
                            "http_status": res.get("http_status"),
                            "error": (res.get("error") or "")[:200]})

    if top_k and top_k > 0:
        merged = merged[:top_k]

    credits = sum(int(r.get("credits_used") or 0) for r in per_tool.values())
    exa_cost = sum(float(r.get("cost_usd") or 0) for r in per_tool.values())

    # The primary backend going dark is worth calling out explicitly: without it
    # the ranking loses its lead signal, even if other backends still return.
    primary_ok = any(t.split(":")[0] == "exa" for t in used)
    payload = {
        "query": query,
        "total_results": len(merged),
        "tools_used": used,
        "tools_used_count": len(used),
        "tools_skipped": skipped,
        "results": merged,
        "elapsed_ms": int((time.time() - started) * 1000),
        "fetched_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "cost_mode": mode,
    }
    if credits:
        payload["firecrawl_credits_used"] = credits
    if exa_cost:
        payload["exa_cost_usd"] = round(exa_cost, 6)
    payload["spend"] = {
        "exa_usd": round(exa_cost, 6),
        "firecrawl_credits": credits,
        "tavily_credits": len([t for t in used if t.startswith("tavily:")]),
        # Yuanbao bills per call (CNY), and the first 2000 calls of each calendar
        # month are free — the call is counted so the monthly budget stays visible.
        "yuanbao_calls": len([t for t in used if t.startswith("yuanbao")]),
    }
    if _enabled("yuanbao", cfg):
        payload["yuanbao_quota"] = yuanbao_quota_snapshot(cfg)
    if not primary_ok:
        payload["primary_backend_missing"] = {
            "backend": "exa",
            "hint": "set EXA_API_KEY or exa_keys in config.json "
                    "(free tier: dashboard.exa.ai → API Keys)",
        }
    if not no_cache and ttl > 0:
        cache_put(ck, payload)
        payload["cache"] = "miss"
    return payload


# ---------------------------------------------------------------------------
# Health probe
# ---------------------------------------------------------------------------
def check_backends(cfg: Dict[str, Any]) -> Dict[str, Any]:
    creds = _credentials(cfg)
    # The probe asks for the smallest useful page: proving a backend answers does
    # not need the same page size as a real search.
    tasks, pre_skipped = build_tasks(cfg, creds, "workbuddy connectivity probe", {},
                                     top_k=MIN_FETCH, mode="cheap")
    out: Dict[str, Any] = {"probe_query": "workbuddy connectivity probe",
                           "backends": {}, "skipped": pre_skipped}
    if tasks:
        with ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as ex:
            futures = {ex.submit(fn, *args, **kw): tid for tid, fn, args, kw in tasks}
            for fut in as_completed(futures):
                tid = futures[fut]
                try:
                    r = fut.result()
                except Exception as e:  # noqa: BLE001
                    r = _fail(tid, "error", error=f"{type(e).__name__}: {e}")
                out["backends"][tid] = {
                    "status": r.get("status"),
                    "results": len(r.get("results") or []),
                    "http_status": r.get("http_status"),
                    "reason": r.get("reason"),
                    "error": (r.get("error") or "")[:160] or None,
                    "credits_used": r.get("credits_used"),
                }
    ok = [b for b, v in out["backends"].items() if v["status"] == "ok"]
    out["healthy"] = sorted(ok)
    out["healthy_count"] = len(ok)
    out["total_backends"] = len(out["backends"])
    # Same verdict fields --setup embeds, so both entry points answer
    # "is the primary backend actually usable" instead of only --setup doing it.
    out["key_problems"] = {b: {"status": v["status"], "reason": v["reason"],
                               "http_status": v["http_status"]}
                           for b, v in out["backends"].items()
                           if v["status"] not in ("ok", None)}
    out["primary_verified"] = any(b.split(":")[0] == "exa" for b in out["healthy"])
    return out


def list_backends(cfg: Dict[str, Any]) -> Dict[str, Any]:
    creds = _credentials(cfg)
    mode = resolve_mode(cfg)
    top_k = int(cfg.get("default_top_k", DEFAULT_TOP_K)) or DEFAULT_TOP_K
    tasks, _ = build_tasks(cfg, creds, "", {}, top_k=top_k, mode=mode)
    weights = {t.split(":")[0]: SOURCE_WEIGHTS.get(t.split(":")[0])
               for t in (x[0] for x in tasks)}
    exa_ready = any(bool(k) for k in creds["exa_keys"])
    return {
        "skill_dir": str(SKILL_DIR),
        "config_path": str(CONFIG_PATH),
        "config_exists": CONFIG_PATH.exists(),
        "primary_backend": "exa",
        "primary_ready": exa_ready,
        "backends": [t[0] for t in tasks],
        "backend_weights": weights,
        "exa_search_type": str(cfg.get("exa_type") or "auto"),
        "yuanbao_mode": YUANBAO_MODES.get(int(cfg.get("yuanbao_mode", 2) or 0), "mixed"),
        "yuanbao_quota": yuanbao_quota_snapshot(cfg),
        "cost_mode": mode,
        "fetch_plan": estimate_cost(top_k, cfg, mode),
        "credentials_present": {
            "exa": any(bool(k) for k in creds["exa_keys"]),
            "yuanbao": bool(creds["yuanbao_api_key"]),
            "firecrawl_keyed": any(bool(k) for k in creds["firecrawl_keys"]),
            "firecrawl_keyless": not any(creds["firecrawl_keys"]),
            "tavily": any(bool(k) for k in creds["tavily_keys"]),
            "zhihu": bool(creds["zhihu_access_secret"]),
            "global": bool(creds["global_access_secret"]),
            "http_sources": len(cfg.get("http_sources") or []),
        },
    }


# ---------------------------------------------------------------------------
# One-shot setup
# ---------------------------------------------------------------------------
def setup(overrides: Dict[str, Any], *, verify: bool = True) -> Dict[str, Any]:
    """Write credentials into config.json without hand-editing JSON.

    Accepts both CLI flags and a JSON payload so a user (or an agent) can bring
    every backend online with a single command, then immediately verify health.
    """
    cfg = _read_json(CONFIG_PATH, {}) if CONFIG_PATH.exists() else {}
    if not isinstance(cfg, dict):
        cfg = {}

    def put_list(key: str, values: Iterable[str]) -> int:
        """Merge new keys into the existing list instead of replacing it.

        Overwriting would silently drop a key the user configured earlier if
        `--setup` is run twice with a subset, so setup is additive by design.
        """
        vals = [str(v).strip() for v in values if str(v).strip()]
        if not vals:
            return 0
        existing = [str(v).strip() for v in (cfg.get(key) or []) if str(v).strip()]
        for v in vals:
            if v not in existing:
                existing.append(v)
        cfg[key] = existing
        return len(existing)

    added: Dict[str, Any] = {}

    exa = list(overrides.get("exa_keys") or [])
    if exa:
        added["exa_keys"] = put_list("exa_keys", exa)
    tav = list(overrides.get("tavily_keys") or [])
    if tav:
        added["tavily_keys"] = put_list("tavily_keys", tav)
    fc = list(overrides.get("firecrawl_keys") or [])
    if fc:
        added["firecrawl_keys"] = put_list("firecrawl_keys", fc)

    for key, arg in (("zhihu_access_secret", "zhihu_access_secret"),
                     ("global_access_secret", "global_access_secret"),
                     ("yuanbao_api_key", "yuanbao_api_key")):
        v = overrides.get(arg)
        if v:
            cfg[key] = str(v).strip()
            added[key] = 1

    # One Zhihu secret covers both site and global search on the Open Platform.
    # If only one was given, mirror it — otherwise the caller has to remember
    # that the same token works twice.
    zh = str(cfg.get("zhihu_access_secret") or "").strip()
    gl = str(cfg.get("global_access_secret") or "").strip()
    if zh and not gl:
        cfg["global_access_secret"] = zh
        added["global_access_secret"] = "mirrored_from_zhihu"
    elif gl and not zh:
        cfg["zhihu_access_secret"] = gl
        added["zhihu_access_secret"] = "mirrored_from_global"

    # Remember where the keys came from so a later run knows they are intentional.
    cfg.setdefault("default_top_k", DEFAULT_TOP_K)
    cfg.setdefault("cache_ttl_seconds", CACHE_TTL_SECONDS)
    cfg.setdefault("cooldown_seconds", COOLDOWN_SECONDS_DEFAULT)
    cfg.setdefault("enabled_backends",
                   ["exa", "yuanbao", "firecrawl", "tavily", "zhihu", "global"])
    cfg.setdefault("yuanbao_mode", 2)
    # A config.json written before Yuanbao existed enumerates its backends in an
    # allow-list, which would silently exclude the new source. Saving the key has
    # to be enough on its own, so merge it in — but only it, never revive a
    # backend the user deliberately removed.
    if cfg.get("yuanbao_api_key"):
        enabled = [str(b) for b in (cfg.get("enabled_backends") or [])]
        if "yuanbao" not in enabled:
            enabled.insert(1 if enabled[:1] == ["exa"] else len(enabled), "yuanbao")
            cfg["enabled_backends"] = enabled
            added["enabled_backends"] = "yuanbao merged into allow-list"
    cfg["_configured_via"] = "parallel_search.py --setup"

    _write_atomic(CONFIG_PATH, json.dumps(cfg, ensure_ascii=False, indent=2))

    out: Dict[str, Any] = {
        "config_path": str(CONFIG_PATH),
        "written": added,
        "backends_now": list_backends(cfg),
    }

    # A key that exists is not a key that works. Without this probe a typo'd
    # secret reports "ready" and the failure only surfaces on the first real
    # search -- by then the user has already wired the tool into their agent.
    if verify:
        health = check_backends(cfg)
        out["verification"] = health
        out["verified_backends"] = health["healthy"]
        out["key_problems"] = health["key_problems"]
        out["primary_verified"] = health["primary_verified"]
        out["cost_note"] = ("verification fired one probe per backend "
                            "(smallest page size, cheap mode)")

    out["next_step"] = ("run: python scripts/parallel_search.py --query \"<test>\" "
                        "--top-k 5 --estimate   # price first, then drop --estimate")
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _emit(obj: Dict[str, Any], out_path: Optional[str]) -> None:
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(text, encoding="utf-8")
    print(text)


def main() -> None:
    ap = argparse.ArgumentParser(
        prog="parallel_search",
        description="Multi-backend parallel web search with quota routing.")
    ap.add_argument("payload", nargs="?", help='JSON payload, e.g. \'{"query":"..."}\'')
    ap.add_argument("--query", "-q", help="search query")
    ap.add_argument("--top-k", type=int, help="max results to return")
    ap.add_argument("--no-cache", action="store_true", help="bypass the result cache")
    ap.add_argument("--cost", choices=sorted(FETCH_FACTORS),
                    help="how much to fetch: cheap | balanced (default) | thorough")
    ap.add_argument("--estimate", action="store_true",
                    help="show what this search would cost, then call nothing")
    ap.add_argument("--timeout", type=int, default=FUTURE_TIMEOUT,
                    help=f"fan-out deadline in seconds (default {FUTURE_TIMEOUT})")
    ap.add_argument("--out", help="also write the JSON result to this path")
    ap.add_argument("--check", action="store_true", help="probe every backend and report health")
    ap.add_argument("--list-backends", action="store_true",
                    help="show resolved backends and which credentials exist")
    ap.add_argument("--setup", action="store_true",
                    help="one-shot: write keys into config.json, then verify each backend")
    ap.add_argument("--no-verify", action="store_true",
                    help="with --setup: only write, skip the probe (a bad key stays hidden)")
    ap.add_argument("--exa-key", action="append", default=[], metavar="KEY",
                    help="Exa API key (repeatable)")
    ap.add_argument("--tavily-key", action="append", default=[], metavar="KEY",
                    help="Tavily API key (repeatable)")
    ap.add_argument("--yuanbao-key", metavar="KEY",
                    help="Tencent Yuanbao Search service API key (sk-...); "
                         "2000 free calls per calendar month")
    ap.add_argument("--firecrawl-key", action="append", default=[], metavar="KEY",
                    help="Firecrawl API key (repeatable)")
    ap.add_argument("--zhihu-secret", metavar="SECRET",
                    help="Zhihu Access Secret (used for both site and global search)")
    ap.add_argument("--global-secret", metavar="SECRET",
                    help="Zhihu Access Secret for global search only")
    args = ap.parse_args()

    if args.setup:
        overrides: Dict[str, Any] = {
            "exa_keys": args.exa_key,
            "tavily_keys": args.tavily_key,
            "firecrawl_keys": args.firecrawl_key,
            "yuanbao_api_key": args.yuanbao_key,
            "zhihu_access_secret": args.zhihu_secret,
            "global_access_secret": args.global_secret,
        }
        if args.payload:
            try:
                extra = json.loads(args.payload)
            except json.JSONDecodeError:
                print(json.dumps({"error": "Invalid JSON payload"}, ensure_ascii=False))
                sys.exit(2)
            if isinstance(extra, dict):
                overrides.update(extra)
        _emit(setup(overrides, verify=not args.no_verify), args.out)
        return

    cfg = load_config()

    if args.list_backends:
        _emit(list_backends(cfg), args.out)
        return
    if args.check:
        _emit(check_backends(cfg), args.out)
        return

    payload: Dict[str, Any] = {}
    if args.payload:
        try:
            payload = json.loads(args.payload)
        except json.JSONDecodeError:
            print(json.dumps({"error": "Invalid JSON payload"}, ensure_ascii=False))
            sys.exit(2)
        if not isinstance(payload, dict):
            print(json.dumps({"error": "payload must be a JSON object"}, ensure_ascii=False))
            sys.exit(2)
    if args.query:
        payload["query"] = args.query
    if args.top_k is not None:
        payload["top_k"] = args.top_k

    query = str(payload.get("query", "")).strip()
    if not query:
        ap.print_usage(sys.stderr)
        print(json.dumps({"error": "query is required (--query or payload 'query')"},
                         ensure_ascii=False))
        sys.exit(2)

    top_k = payload.get("top_k", args.top_k)
    try:
        top_k = int(top_k) if top_k is not None else None
    except (TypeError, ValueError):
        top_k = None
    if top_k is None:
        top_k = int(cfg.get("default_top_k", DEFAULT_TOP_K)) or None

    mode = resolve_mode(cfg, args.cost)

    if args.estimate:
        # Print what this would cost and call nothing.
        _emit(estimate_cost(top_k or DEFAULT_TOP_K, cfg, mode), args.out)
        return

    result = run_parallel_search(
        query, cfg, top_k=top_k,
        no_cache=bool(args.no_cache or payload.get("no_cache")),
        timeout=int(args.timeout), cost_mode=mode,
    )
    _emit(result, args.out)


if __name__ == "__main__":
    main()