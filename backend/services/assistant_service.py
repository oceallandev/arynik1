from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


ROLE_GUIDANCE: Dict[str, str] = {
    "Admin": "Ai acces larg la operatiuni, utilizatori, rute, notificari, COD, AWB, manifeste.",
    "Manager": "Coordonezi operatiuni, rute, alocari si monitorizare echipa.",
    "Dispatcher": "Coordonezi alocarea livrarilor si comunicarea operationala.",
    "Warehouse": "Gestionezi descarcare/incarcare, manifeste si flux operational in depozit.",
    "Driver": "Executi ruta, actualizezi statusuri AWB, comunici cu clientul.",
    "Support": "Asisti clienti si echipe pe fluxuri operationale.",
    "Finance": "Urmaresti COD, incasari si discrepante financiare pe AWB/sofer.",
    "Viewer": "Ai acces de vizualizare pentru monitorizare.",
    "Recipient": "Urmaresti AWB-ul propriu, chat si notificari livrare.",
}

APP_CAPABILITIES = [
    "Urmarire AWB si statusuri livrare (inclusiv istoric evenimente).",
    "Planificare rute, alocare sofer/masina/manipulant, executie ruta.",
    "Manifeste de incarcare/descarcare, scanare AWB, import bulk AWB.",
    "Notificari interne/externe, chat pe AWB, locatie partajata in chat.",
    "Raportare COD si operatiuni financiare.",
    "Gestionare utilizatori, roluri, flota si documente.",
]


def _likely_romanian(text: str) -> bool:
    sample = str(text or "").lower()
    if not sample:
        return True
    ro_hits = [
        "cum", "pot", "vreau", "awb", "livrare", "sofer", "client", "ruta",
        "de ce", "unde", "cand", "aplicatie", "notificari", "chat", "ramburs",
    ]
    score = sum(1 for token in ro_hits if token in sample)
    return score >= 1


def _safe_text(value: Any) -> str:
    return str(value or "").strip()


def _fallback_answer(question: str, role: str, context: Dict[str, Any]) -> Dict[str, Any]:
    q = str(question or "").strip()
    q_low = q.lower()
    shipments = context.get("shipments") if isinstance(context, dict) else None
    shipment_rows = list(shipments or []) if isinstance(shipments, list) else []

    ro = _likely_romanian(q)
    role_txt = ROLE_GUIDANCE.get(role, ROLE_GUIDANCE.get("Viewer", ""))
    suggestions = [
        "Cum verific rapid statusul unui AWB?",
        "Cum trimit notificare catre client?",
        "Cum vad ce are de facut soferul pe ruta?",
    ] if ro else [
        "How do I quickly check an AWB status?",
        "How do I notify a customer?",
        "How do I see driver route tasks?",
    ]

    if shipment_rows:
        lines: List[str] = []
        for row in shipment_rows[:3]:
            awb = _safe_text(row.get("awb")).upper() or "--"
            status = _safe_text(row.get("status")) or ("Necunoscut" if ro else "Unknown")
            locality = _safe_text(row.get("locality"))
            cod_amount = row.get("cod_amount")
            cod_txt = ""
            try:
                cod_n = float(cod_amount or 0)
                if cod_n > 0:
                    cod_txt = f", COD {cod_n:.2f} RON"
            except Exception:
                cod_txt = ""
            loc_txt = f", {locality}" if locality else ""
            lines.append(f"- {awb}: {status}{loc_txt}{cod_txt}")

        if ro:
            answer = (
                "Am gasit context pe AWB-urile mentionate:\n"
                + "\n".join(lines)
                + "\n\n"
                + f"Recomandare pentru rolul tau: {role_txt}"
                + "\nPot sa te ghidez pas cu pas pentru urmatoarea actiune in aplicatie."
            )
        else:
            answer = (
                "I found context for the AWBs mentioned:\n"
                + "\n".join(lines)
                + "\n\n"
                + f"Role guidance: {role_txt}"
                + "\nI can guide you step by step for the next action in the app."
            )
        return {
            "answer": answer,
            "suggestions": suggestions,
            "provider": "local_fallback",
            "model": None,
        }

    if "eroare" in q_low or "error" in q_low or "nu merge" in q_low or "problem" in q_low:
        answer = (
            "Pentru a diagnostica rapid, spune-mi: ecranul unde apare problema, pasii exacti si mesajul de eroare."
            " Daca ai AWB, include-l si iti dau pasii de remediere."
            if ro else
            "To diagnose quickly, tell me the screen, exact steps, and the error message."
            " If you have an AWB, include it and I will give precise remediation steps."
        )
    elif "awb" in q_low:
        answer = (
            "Pentru AWB, cauta direct in ecranul Shipments sau apasa pe AWB din liste (ruta/notificari/chat)."
            " Daca imi dai AWB-ul aici, iti explic exact ce inseamna statusul si urmatorul pas."
            if ro else
            "For AWB, open Shipments directly or tap AWB from route/notifications/chat lists."
            " If you provide the AWB here, I can explain status meaning and next step."
        )
    elif "ruta" in q_low or "route" in q_low:
        answer = (
            "In fluxul de rute: generezi/aprobi ruta, aloci resursele (sofer/masina), apoi executi in Route Run."
            " Pot sa-ti dau checklistul exact pentru rolul tau."
            if ro else
            "In route flow: generate/approve route, assign resources (driver/vehicle), then execute in Route Run."
            " I can provide an exact checklist for your role."
        )
    else:
        answer = (
            "Pot raspunde la intrebari despre AWB, rute, chat, notificari, COD, manifeste, utilizatori si setari."
            " Spune-mi concret ce ecran folosesti si ce rezultat vrei."
            if ro else
            "I can answer questions about AWB, routes, chat, notifications, COD, manifests, users and settings."
            " Tell me which screen you are using and the exact outcome you want."
        )

    return {
        "answer": answer,
        "suggestions": suggestions,
        "provider": "local_fallback",
        "model": None,
    }


def _extract_openai_text(payload: Dict[str, Any]) -> str:
    txt = _safe_text(payload.get("output_text"))
    if txt:
        return txt

    out = payload.get("output")
    if not isinstance(out, list):
        return ""

    parts: List[str] = []
    for item in out:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for chunk in content:
            if not isinstance(chunk, dict):
                continue
            ctype = str(chunk.get("type") or "").strip().lower()
            if ctype in {"output_text", "text"}:
                value = _safe_text(chunk.get("text"))
                if value:
                    parts.append(value)
    return "\n".join(parts).strip()


async def _answer_with_openai(*, question: str, role: str, context: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    api_key = str(os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return None

    model = str(os.getenv("OPENAI_ASSISTANT_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4o-mini").strip()
    base = str(os.getenv("OPENAI_API_BASE_URL") or "https://api.openai.com/v1").strip().rstrip("/")
    endpoint = f"{base}/responses"

    capabilities_text = "\n".join([f"- {item}" for item in APP_CAPABILITIES])
    role_text = ROLE_GUIDANCE.get(role, ROLE_GUIDANCE.get("Viewer", ""))
    context_text = str(context or "{}")
    if len(context_text) > 10000:
        context_text = context_text[:10000] + " ...[truncated]"

    system_prompt = (
        "Esti asistent virtual pentru platforma AryNik (logistica). "
        "Raspunzi strict la intrebari legate de aplicatie, fluxuri operationale si date contextuale primite. "
        "Nu inventa date; daca lipsesc, spune clar ce lipseste. "
        "Raspunde clar, practic, in pasi scurti.\n"
        f"Context rol: {role_text}\n"
        "Capabilitati platforma:\n"
        f"{capabilities_text}"
    )

    user_prompt = (
        f"Intrebare: {question}\n\n"
        "Context JSON (date interne curente):\n"
        f"{context_text}\n\n"
        "Daca intrebarea nu tine de aplicatie, redirectioneaza politicos catre subiecte din aplicatie."
    )

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
            {"role": "user", "content": [{"type": "input_text", "text": user_prompt}]},
        ],
        "max_output_tokens": 600,
        "temperature": 0.2,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(endpoint, json=payload, headers=headers)
        if int(resp.status_code) >= 400:
            logger.warning("Assistant OpenAI call failed (%s): %s", resp.status_code, resp.text[:500])
            return None
        data = resp.json() if resp.content else {}
        answer = _extract_openai_text(data if isinstance(data, dict) else {})
        if not answer:
            return None
        return {
            "answer": answer,
            "suggestions": _fallback_answer(question, role, context).get("suggestions") or [],
            "provider": "openai",
            "model": model,
        }
    except Exception as exc:
        logger.warning("Assistant OpenAI call error: %s", str(exc))
        return None


async def answer_question(*, question: str, role: str, context: Dict[str, Any]) -> Dict[str, Any]:
    q = _safe_text(question)
    if not q:
        return {
            "answer": "Intrebarea este goala. Scrie o intrebare concreta despre aplicatie.",
            "suggestions": [],
            "provider": "local_fallback",
            "model": None,
        }

    ai_answer = await _answer_with_openai(question=q, role=role, context=context)
    if ai_answer:
        return ai_answer
    return _fallback_answer(q, role, context)
