"""Anti-hallucination guardrail — every refdes the agent mentions passes here.

Pure functions over an already-parsed `Board`. No I/O, no mutation. If a
lookup fails the caller is expected to return a structured null/unknown
response, not fabricate data (per the anti-hallucination contract).

Refdes lookup is forgiving on spelling but never ambiguous: an exact
match wins, then a *unique* case-insensitive match (``"u1"`` → ``U1``).
When two parts differ only by case (``R1`` and ``r1``) the casefold
fallback is disabled for that key and only exact spellings resolve —
the guardrail must never pick one of two real parts on a guess.
Leading/trailing whitespace is ignored. Callers that echo a refdes back
(WS events, summaries) should use the returned ``Part.refdes`` — the
canonical board spelling — not the raw input.
"""

from __future__ import annotations

from api.board.model import Board, Net, Part, Pin


def _clean(refdes: object) -> str:
    return refdes.strip() if isinstance(refdes, str) else ""


def _unique_casefold(board: Board, key: str) -> Part | None:
    """The single part whose refdes casefolds to `key`, else None (0 or 2+)."""
    folded = key.casefold()
    found: Part | None = None
    for part in board.parts:
        if part.refdes.casefold() == folded:
            if found is not None:
                return None  # R1 vs r1 — ambiguous, never guess
            found = part
    return found


def resolve_part(board: Board, refdes: str) -> Part | None:
    """Return the Part for `refdes`, or None.

    Exact match first, then a unique case-insensitive match. Whitespace
    around the input is ignored; None / non-str / blank input → None.
    """
    key = _clean(refdes)
    if not key:
        return None
    part = board.part_by_refdes(key)
    if part is not None:
        return part
    return _unique_casefold(board, key)


def is_valid_refdes(board: Board, refdes: str) -> bool:
    """Return True iff `refdes` resolves to a part on the board.

    Same rules as `resolve_part` (exact, then unique case-insensitive).
    The refdes sanitizer only scans uppercase-shaped tokens, so the
    casefold fallback only matters for boards that store lowercase refdes.
    """
    return resolve_part(board, refdes) is not None


def resolve_net(board: Board, net_name: str) -> Net | None:
    """Return the Net named `net_name`, or None."""
    return board.net_by_name(net_name)


def resolve_pin_matches(board: Board, refdes: str, pin: int | str) -> list[Pin]:
    """All pads of `refdes` that `pin` designates, in file order ([] if none).

    `pin` is what a technician reads off the silkscreen / datasheet: a pad
    *name* (``3``, ``"3"``, ``"A1"``, ``"EP"``). Resolution order:

    1. exact match on `Pin.name` (stringified, whitespace-stripped) — pad
       names are not unique (``EP`` / ``GND`` / mounting tabs repeat), so
       every pad carrying that name is returned;
    2. fallback on `Pin.index` (1-based file order) when `pin` is an int or
       a decimal string — only for parts that carry *no* pad names at all,
       the norm on formats that ship none (most `.brd` dialects).

    Name-first matters: KiCad emits unnamed mechanical pads first, so file
    order and pad number disagree on those footprints. For the same reason
    a named part never falls back to file order: U1 numbered 1..200 plus
    two unnamed tabs would otherwise map "201" onto pad "199".
    """
    part = resolve_part(board, refdes)
    if part is None or isinstance(pin, bool):
        return []
    if isinstance(pin, int):
        label, number = str(pin), pin
    elif isinstance(pin, str):
        label = pin.strip()
        number = int(label) if label.isdecimal() else None
    else:
        return []
    if not label:
        return []
    pads = [board.pins[i] for i in part.pin_refs]
    named = [p for p in pads if p.name is not None and p.name.strip() == label]
    if named:
        return named
    if number is None or any(p.name is not None for p in pads):
        return []
    return [p for p in pads if p.index == number][:1]


def resolve_pin(board: Board, refdes: str, pin: int | str) -> Pin | None:
    """Return the first pad `pin` designates on `refdes`, or None.

    See `resolve_pin_matches` for the name-then-index rules; use it
    directly when the caller needs to know how many pads share a name.
    """
    matches = resolve_pin_matches(board, refdes, pin)
    return matches[0] if matches else None


def suggest_similar(board: Board, refdes: str, k: int = 3) -> list[str]:
    """Return up to `k` refdes names closest to `refdes` by Levenshtein distance.

    Distance is computed case-insensitively (``"u1"`` ranks ``U1`` first)
    but the board's original spelling is returned. Order is ascending
    distance; ties broken by the casefolded then the original refdes so
    calls are deterministic across runs.

    The input is stripped of leading/trailing whitespace before comparison.
    An empty, whitespace-only or non-string input, or `k <= 0`, returns an
    empty list — there is no sensible "close match" to whitespace.
    """
    query = _clean(refdes).casefold()
    if not query or k <= 0:
        return []
    candidates = [p.refdes for p in board.parts]
    scored = sorted(
        candidates,
        key=lambda c: (_levenshtein(query, c.casefold()), c.casefold(), c),
    )
    return scored[:k]


def _levenshtein(a: str, b: str) -> int:
    """Classic iterative Wagner–Fischer DP.

    Space-optimized to two rows. Runs in O(len(a) * len(b)) time and
    O(min(len(a), len(b))) space.
    """
    if len(a) < len(b):
        return _levenshtein(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            ins = curr[j - 1] + 1
            dele = prev[j] + 1
            sub = prev[j - 1] + (ca != cb)
            curr.append(min(ins, dele, sub))
        prev = curr
    return prev[-1]
