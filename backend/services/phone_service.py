from __future__ import annotations

from typing import Optional


def digits_only(value: str) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def normalize_phone(value: str) -> Optional[str]:
    """
    Normalize phone numbers into a stable, digits-only identifier for matching.

    Assumptions:
    - Primary market is Romania (country code 40), but we keep other country codes intact.
    - We canonicalize common RO formats so "0712..." / "712..." / "+40712..." match.
    """
    raw = str(value or "").strip()
    if not raw:
        return None

    digits = digits_only(raw)
    if not digits:
        return None

    # Strip international dialing prefix if present (00... -> ...).
    if digits.startswith("00") and len(digits) > 2:
        digits = digits[2:]

    # Romania canonicalization:
    # - 07xxxxxxxx -> 40xxxxxxxxx
    # - 7xxxxxxxx  -> 40xxxxxxxxx
    if len(digits) == 10 and digits.startswith("0"):
        digits = "40" + digits[1:]
    elif len(digits) == 9 and digits.startswith("7"):
        digits = "40" + digits

    return digits or None


def to_e164(normalized_digits: str) -> Optional[str]:
    d = str(normalized_digits or "").strip()
    if not d:
        return None
    if d.startswith("+"):
        return d
    return f"+{d}"

