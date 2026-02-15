from __future__ import annotations

import logging
import os
from typing import Optional

import requests

try:
    from .phone_service import normalize_phone, to_e164
except ImportError:  # pragma: no cover
    from phone_service import normalize_phone, to_e164  # type: ignore

logger = logging.getLogger(__name__)


def _twilio_configured() -> bool:
    return bool(
        os.getenv("TWILIO_ACCOUNT_SID")
        and os.getenv("TWILIO_AUTH_TOKEN")
        and os.getenv("TWILIO_WHATSAPP_FROM")
    )


def send_whatsapp_message(to_phone: str, body: str) -> bool:
    """
    Best-effort WhatsApp notification sender.

    Supported provider:
    - Twilio WhatsApp (env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM)

    If not configured, we log and return False.
    """
    msg = str(body or "").strip()
    if not msg:
        return False

    phone_norm = normalize_phone(to_phone)
    to_e164_val: Optional[str] = to_e164(phone_norm) if phone_norm else None
    if not to_e164_val:
        logger.warning("WhatsApp send skipped: invalid phone number")
        return False

    if not _twilio_configured():
        logger.info("WhatsApp not configured; skipping send (to=%s)", to_e164_val)
        return False

    sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
    token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_FROM", "").strip()

    try:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
        resp = requests.post(
            url,
            data={
                "From": from_whatsapp,
                "To": f"whatsapp:{to_e164_val}",
                "Body": msg,
            },
            auth=(sid, token),
            timeout=10,
        )
        if 200 <= resp.status_code < 300:
            return True
        logger.warning("Twilio WhatsApp send failed: status=%s body=%s", resp.status_code, resp.text[:500])
        return False
    except Exception as e:
        logger.warning("Twilio WhatsApp send exception: %s", str(e))
        return False

