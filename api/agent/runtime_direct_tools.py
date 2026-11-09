"""Tool dispatchers for the direct diagnostic runtime."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import secrets
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from fastapi import WebSocket

from api.agent.macros import persist_macro
from api.agent.tools import (
    mb_expand_knowledge,
    mb_get_component,
    mb_get_rules_for_symptoms,
    mb_record_finding,
)
from api.config import get_settings
from api.session.state import SessionState
from api.tools.schematic import mb_schematic_graph

logger = logging.getLogger("wrench_board.agent.direct")


async def _await_protocol_confirmation(
    ws: WebSocket, tool_use_id: str, timeout_s: float
) -> dict | None:
    """Park on the WS until the tech accepts/rejects THIS proposal, or the
    inactivity timeout fires.

    Direct mode is a single sequential loop (unlike runtime_managed's two
    concurrent forwarders), so the dispatch reads the socket itself while the
    confirmation modal is up. The tech is expected to only click accept/reject,
    so any unrelated frame that arrives mid-wait is drained. Returns the
    decision frame, or None on timeout.
    """
    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=timeout_s)
        except TimeoutError:
            return None
        try:
            frame = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        if (
            isinstance(frame, dict)
            and frame.get("type") == "client.protocol_confirmation"
            and frame.get("tool_use_id") == tool_use_id
        ):
            return frame
        # ignore any other frame while waiting for this confirmation


async def _propose_protocol_with_confirmation(
    *,
    ws: WebSocket,
    block: Any,
    device_slug: str,
    memory_root: Path,
    session: SessionState,
    repair_id: str | None,
    conv_id: str | None,
) -> dict:
    """bv_propose_protocol with the Pattern-4 tech-confirmation handshake.

    Emit ``protocol_pending_confirmation``, park on the WS for the tech's
    accept/reject (or time out), and only run the real dispatch on accept.
    Mirrors runtime_managed's ``_dispatch_protocol_with_confirmation`` minus the
    Managed-Agents event plumbing — direct mode returns the result inline to the
    turn loop, which feeds it back to the agent as the tool_result.
    """
    tool_use_id = getattr(block, "id", None) or ""
    tool_input = block.input or {}
    timeout_s = get_settings().ma_protocol_confirmation_timeout_seconds

    # Lightweight projection for the modal — title + rationale + step previews
    # (12 max). The full payload would bloat the frame; the modal needs the gist.
    steps = list(tool_input.get("steps") or [])
    step_previews = [
        {
            "type": s.get("type"),
            "target": s.get("target"),
            "test_point": s.get("test_point"),
            "instruction": s.get("instruction"),
        }
        for s in steps[:12]
    ]
    await ws.send_json({
        "type": "protocol_pending_confirmation",
        "tool_use_id": tool_use_id,
        "title": tool_input.get("title") or "",
        "rationale": tool_input.get("rationale") or "",
        "step_count": len(steps),
        "steps": step_previews,
        "rule_inspirations": list(tool_input.get("rule_inspirations") or []),
        "timeout_seconds": timeout_s,
    })

    decision = await _await_protocol_confirmation(ws, tool_use_id, timeout_s)

    if decision is None:
        # Tech never answered — drop the modal and tell the agent so it doesn't
        # assume the protocol is live. No protocol is materialised on disk.
        try:
            await ws.send_json({
                "type": "protocol_confirmation_timeout",
                "tool_use_id": tool_use_id,
                "timeout_seconds": timeout_s,
            })
        except Exception:  # noqa: BLE001 — best-effort UI hint
            pass
        return {
            "ok": False,
            "reason": "confirmation_timeout",
            "error": (
                f"Protocol confirmation timed out after {timeout_s:.0f}s — the "
                "technician did not respond. Try again with a tighter, more "
                "obvious protocol or ask in chat first."
            ),
        }

    verdict = str(decision.get("decision") or "").lower().strip()
    if verdict == "accept":
        return await _dispatch_protocol_tool(
            "bv_propose_protocol",
            tool_input,
            device_slug,
            memory_root,
            session,
            repair_id=repair_id,
            conv_id=conv_id,
        )

    # reject (or any non-accept value) — never materialise; hand the tech's
    # reason back to the agent so it pivots instead of re-emitting.
    reason = str(decision.get("reason") or "").strip()
    return {
        "ok": False,
        "reason": "rejected",
        "error": (
            "Technician rejected the proposed protocol. Reason: "
            f"{reason or '(none given)'}. Do not re-emit the same protocol; "
            "either ask a clarifying question, propose a different approach, or "
            "wait for further instruction."
        ),
    }


async def _await_capture_response(
    ws: WebSocket, request_id: str, timeout_s: float
) -> dict | None:
    """Park on the WS until the matching client.capture_response arrives, or
    the timeout fires. Same sequential-read rationale as
    :func:`_await_protocol_confirmation`. Returns the response frame or None."""
    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=timeout_s)
        except TimeoutError:
            return None
        try:
            frame = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        if (
            isinstance(frame, dict)
            and frame.get("type") == "client.capture_response"
            and frame.get("request_id") == request_id
        ):
            return frame


async def _dispatch_cam_capture_direct(
    *,
    ws: WebSocket,
    client: AsyncAnthropic,
    memory_root: Path,
    device_slug: str,
    repair_id: str | None,
    block: Any,
) -> dict:
    """cam_capture (Flow B) for direct mode: push a server.capture_request,
    await the frame, persist + upload it to the Files API, and return an
    image-shaped tool_result content list. Mirrors runtime/camera.py minus the
    Managed-Agents event envelope — direct returns the content inline to the
    turn loop (which wraps it as the tool_result). Always returns a dict with
    ``tool_result_content`` (a list of content blocks)."""
    tool_use_id = getattr(block, "id", None) or ""
    tool_input = block.input or {}
    timeout_s = get_settings().ma_camera_capture_timeout_seconds
    request_id = secrets.token_urlsafe(8)

    await ws.send_json({
        "type": "server.capture_request",
        "request_id": request_id,
        "tool_use_id": tool_use_id,
        "reason": tool_input.get("reason") or "",
    })

    response = await _await_capture_response(ws, request_id, timeout_s)
    if response is None:
        return {
            "ok": False,
            "is_error": True,
            "tool_result_content": [{
                "type": "text",
                "text": (
                    f"Capture timeout after {timeout_s:.0f}s — the frontend did "
                    "not respond. Check that a camera is selected in the metabar."
                ),
            }],
        }

    try:
        bytes_ = base64.b64decode(response.get("base64") or "", validate=True)
        if not bytes_:
            raise ValueError("empty payload")
        mime = (response.get("mime") or "image/jpeg").lower()
        device_label = response.get("device_label") or "camera"

        persist_macro(
            memory_root=memory_root, slug=device_slug, repair_id=repair_id or "",
            source="capture", bytes_=bytes_, mime=mime,
        )
        uploaded = await client.beta.files.upload(
            file=(f"capture_{request_id}.jpg", bytes_, mime),
        )
        return {
            "ok": True,
            "tool_result_content": [
                {"type": "image",
                 "source": {"type": "file", "file_id": uploaded.id}},
                {"type": "text",
                 "text": f"Capture acquise depuis {device_label}."},
            ],
        }
    except Exception as exc:  # noqa: BLE001 — never crash the turn on a bad frame
        logger.exception("[Diag-Direct] cam_capture processing failed")
        return {
            "ok": False,
            "is_error": True,
            "tool_result_content": [{
                "type": "text", "text": f"Capture processing failed: {exc}",
            }],
        }


async def _dispatch_protocol_tool(
    name: str,
    payload: dict,
    device_slug: str,
    memory_root: Path,
    session: SessionState,
    repair_id: str | None = None,
    conv_id: str | None = None,
) -> dict:
    """Dispatch the 4 stepwise-protocol tools (bv_propose_protocol, bv_update_protocol,
    bv_record_step_result, bv_get_protocol). Mirrors the branches in runtime_managed._dispatch_tool.
    """
    if name == "bv_propose_protocol":
        from api.tools.protocol import (
            StepInput as _SI,
        )
        from api.tools.protocol import (
            propose_protocol as _propose,
        )

        valid_refdes = (
            {p.refdes for p in session.board.parts}
            if session.board is not None
            else None
        )
        # Tolerate "comp:U7" / "rail:+5V" prefixes the agent learns from
        # mb_set_observation; strip "comp:" so the refdes validates, drop
        # rail/test-point prefixes into test_point so the step still anchors
        # somewhere meaningful even without a board part.
        for s in payload.get("steps", []) or []:
            t = s.get("target")
            if isinstance(t, str) and ":" in t:
                kind, _, rest = t.partition(":")
                if kind == "comp":
                    s["target"] = rest
                else:
                    s["target"] = None
                    s.setdefault("test_point", t)
        try:
            step_inputs = [_SI.model_validate(s) for s in payload.get("steps", [])]
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": "invalid_step_input", "detail": str(exc)}
        result = _propose(
            memory_root=memory_root,
            device_slug=device_slug,
            repair_id=repair_id or "",
            title=payload.get("title", ""),
            rationale=payload.get("rationale", ""),
            steps=step_inputs,
            rule_inspirations=payload.get("rule_inspirations") or None,
            valid_refdes=valid_refdes,
            conv_id=conv_id,
        )
        if result.get("ok"):
            from api.tools.protocol import load_active_protocol
            proto = load_active_protocol(memory_root, device_slug, repair_id or "", conv_id=conv_id)
            if proto is not None:
                result["event"] = {
                    "type": "protocol_proposed",
                    "protocol_id": proto.protocol_id,
                    "title": proto.title,
                    "rationale": proto.rationale,
                    "steps": [s.model_dump() for s in proto.steps],
                    "current_step_id": proto.current_step_id,
                }
        return result

    if name == "bv_update_protocol":
        from api.tools.protocol import StepInput as _SI
        from api.tools.protocol import update_protocol as _update

        new_step_payload = payload.get("new_step")
        new_step = None
        if new_step_payload is not None:
            try:
                new_step = _SI.model_validate(new_step_payload)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "reason": "invalid_new_step", "detail": str(exc)}
        result = _update(
            memory_root=memory_root,
            device_slug=device_slug,
            repair_id=repair_id or "",
            action=payload.get("action", ""),
            reason=payload.get("reason", ""),
            step_id=payload.get("step_id"),
            after=payload.get("after"),
            new_step=new_step,
            new_order=payload.get("new_order"),
            verdict=payload.get("verdict"),
            conv_id=conv_id,
        )
        if result.get("ok"):
            from api.tools.protocol import load_active_protocol
            proto = load_active_protocol(memory_root, device_slug, repair_id or "", conv_id=conv_id)
            history_tail = proto.history[-3:] if proto is not None else []
            result["event"] = {
                "type": "protocol_updated",
                "protocol_id": result.get("protocol_id"),
                "action": payload.get("action"),
                "current_step_id": result.get("current_step_id"),
                "steps": [s.model_dump() for s in (proto.steps if proto else [])],
                "history_tail": [h.model_dump() for h in history_tail],
            }
        return result

    if name == "bv_record_step_result":
        from api.tools.protocol import record_step_result as _record
        result = _record(
            memory_root=memory_root,
            device_slug=device_slug,
            repair_id=repair_id or "",
            step_id=payload.get("step_id", ""),
            value=payload.get("value"),
            unit=payload.get("unit"),
            observation=payload.get("observation"),
            skip_reason=payload.get("skip_reason"),
            submitted_by="agent",
            conv_id=conv_id,
        )
        if result.get("ok"):
            from api.tools.protocol import load_active_protocol
            proto = load_active_protocol(memory_root, device_slug, repair_id or "", conv_id=conv_id)
            history_tail = proto.history[-3:] if proto is not None else []
            result["event"] = {
                "type": "protocol_updated",
                "protocol_id": result.get("protocol_id"),
                "action": "step_completed",
                "current_step_id": result.get("current_step_id"),
                "steps": [s.model_dump() for s in (proto.steps if proto else [])],
                "history_tail": [h.model_dump() for h in history_tail],
            }
        return result

    if name == "bv_get_protocol":
        from api.tools.protocol import load_active_protocol
        proto = load_active_protocol(memory_root, device_slug, repair_id or "", conv_id=conv_id)
        if proto is None:
            return {"ok": True, "active": False}
        return {
            "ok": True, "active": True,
            "protocol_id": proto.protocol_id,
            "title": proto.title,
            "rationale": proto.rationale,
            "current_step_id": proto.current_step_id,
            "status": proto.status,
            "steps": [s.model_dump() for s in proto.steps],
            "history": [h.model_dump() for h in proto.history],
        }

    logger.warning("unknown protocol tool: %s", name)
    return {"ok": False, "reason": "unknown-tool", "error": f"unknown protocol tool: {name}"}


async def _dispatch_mb_tool(
    name: str,
    payload: dict,
    device_slug: str,
    memory_root: Path,
    client: AsyncAnthropic,
    session: SessionState,
    session_id: str | None = None,
    repair_id: str | None = None,
    conv_id: str | None = None,
) -> dict:
    """Run one of the mb_* memory-bank tools. Passes `session` so mb_get_component can aggregate."""
    # Direct-mode memory recall (parity with the managed FUSE stores). Read-only
    # wrappers over api.agent.recall — see manifest RECALL_TOOLS.
    if name == "mb_recall_field_reports":
        from api.agent.recall import recall_field_reports

        reports = recall_field_reports(
            device_slug=device_slug,
            memory_root=memory_root,
            query=payload.get("query"),
            refdes=payload.get("refdes"),
            limit=payload.get("limit", 8),
        )
        return {"ok": True, "reports": reports, "count": len(reports)}
    if name == "mb_search_patterns":
        from api.agent.recall import search_patterns

        patterns = search_patterns(payload.get("query", ""))
        return {"ok": True, "patterns": patterns, "count": len(patterns)}
    if name == "mb_search_playbooks":
        from api.agent.recall import search_playbooks

        playbooks = search_playbooks(payload.get("symptom", ""))
        return {"ok": True, "playbooks": playbooks, "count": len(playbooks)}
    if name == "mb_get_component":
        return mb_get_component(
            device_slug=device_slug,
            refdes=payload.get("refdes", ""),
            memory_root=memory_root,
            session=session,
        )
    if name == "mb_get_rules_for_symptoms":
        return mb_get_rules_for_symptoms(
            device_slug=device_slug,
            symptoms=payload.get("symptoms", []),
            memory_root=memory_root,
            max_results=payload.get("max_results", 5),
            session=session,
        )
    if name == "mb_record_finding":
        return await mb_record_finding(
            client=client,
            device_slug=device_slug,
            refdes=payload.get("refdes", ""),
            symptom=payload.get("symptom", ""),
            confirmed_cause=payload.get("confirmed_cause", ""),
            memory_root=memory_root,
            mechanism=payload.get("mechanism"),
            notes=payload.get("notes"),
            session_id=session_id,
        )
    if name == "mb_record_session_log":
        from api.agent.tools import mb_record_session_log as _mb_session_log

        return await _mb_session_log(
            client=client,
            device_slug=device_slug,
            repair_id=repair_id or session_id or "",
            conv_id=conv_id or "",
            symptom=payload.get("symptom", ""),
            outcome=payload.get("outcome", "unresolved"),
            memory_root=memory_root,
            tested=payload.get("tested"),
            hypotheses=payload.get("hypotheses"),
            findings=payload.get("findings"),
            next_steps=payload.get("next_steps"),
            lesson=payload.get("lesson"),
        )
    if name == "mb_schematic_graph":
        return mb_schematic_graph(
            device_slug=device_slug,
            memory_root=memory_root,
            query=payload.get("query", ""),
            label=payload.get("label"),
            refdes=payload.get("refdes"),
            index=payload.get("index"),
            domain=payload.get("domain"),
            killed_refdes=payload.get("killed_refdes"),
            failures=payload.get("failures"),
            rail_overrides=payload.get("rail_overrides"),
            session=session,
        )
    if name == "mb_hypothesize":
        from api.tools.hypothesize import mb_hypothesize as _mb_hypothesize

        return _mb_hypothesize(
            device_slug=device_slug,
            memory_root=memory_root,
            state_comps=payload.get("state_comps"),
            state_rails=payload.get("state_rails"),
            metrics_comps=payload.get("metrics_comps"),
            metrics_rails=payload.get("metrics_rails"),
            max_results=payload.get("max_results", 5),
            # Always pass the session's repair_id — it scopes the
            # diagnosis_log.jsonl hook (for field-corpus calibration) and
            # is the fallback for journal-based synthesis when the agent
            # didn't supply explicit state/metrics.
            repair_id=payload.get("repair_id") or session_id,
        )
    if name == "mb_record_measurement":
        from api.tools.measurements import mb_record_measurement as _mb_rec

        return _mb_rec(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
            target=payload.get("target", ""),
            value=payload.get("value", 0.0),
            unit=payload.get("unit", "V"),
            nominal=payload.get("nominal"),
            note=payload.get("note"),
            source="agent",
        )
    if name == "mb_list_measurements":
        from api.tools.measurements import mb_list_measurements as _mb_list

        return _mb_list(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
            target=payload.get("target"),
            since=payload.get("since"),
        )
    if name == "mb_compare_measurements":
        from api.tools.measurements import mb_compare_measurements as _mb_cmp

        return _mb_cmp(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
            target=payload.get("target", ""),
            before_ts=payload.get("before_ts"),
            after_ts=payload.get("after_ts"),
        )
    if name == "mb_observations_from_measurements":
        from api.tools.measurements import mb_observations_from_measurements as _mb_syn

        return _mb_syn(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
        )
    if name == "mb_set_observation":
        from api.tools.measurements import mb_set_observation as _mb_set

        return _mb_set(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
            target=payload.get("target", ""),
            mode=payload.get("mode", "unknown"),
        )
    if name == "mb_clear_observations":
        from api.tools.measurements import mb_clear_observations as _mb_clr

        return _mb_clr(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
        )
    if name == "mb_validate_finding":
        from api.tools.validation import mb_validate_finding as _mb_val

        return _mb_val(
            device_slug=device_slug,
            repair_id=session_id or "",
            memory_root=memory_root,
            fixes=payload.get("fixes", []),
            tech_note=payload.get("tech_note"),
            agent_confidence=payload.get("agent_confidence", "high"),
        )
    if name == "mb_expand_knowledge":
        return await mb_expand_knowledge(
            client=client,
            device_slug=device_slug,
            focus_symptoms=payload.get("focus_symptoms", []),
            focus_refdes=payload.get("focus_refdes", []),
            memory_root=memory_root,
            session=session,
        )
    logger.warning("unknown mb_* tool: %s", name)
    return {"ok": False, "reason": "unknown-tool"}


def _dispatch_profile_tool(name: str, payload: dict, session=None) -> dict:
    """Run one of the profile_* technician-profile tools."""
    from api.profile.tools import (
        profile_check_skills,
        profile_get,
        profile_track_skill,
    )

    if name == "profile_get":
        return profile_get(session=session)
    if name == "profile_check_skills":
        return profile_check_skills(payload.get("candidate_skills", []))
    if name == "profile_track_skill":
        return profile_track_skill(
            payload.get("skill_id", ""),
            payload.get("evidence", {}),
        )
    logger.warning("unknown profile_* tool: %s", name)
    return {"ok": False, "reason": "unknown-tool"}


def _dispatch_stock_tool(name: str, payload: dict) -> dict:
    """Run one of the stock_* donor-inventory tools.

    Mirrors ``tool_dispatch._dispatch_stock`` (the managed path). Lazy-imports
    ``api.stock.tools`` to keep the optional package decoupled from the runtime,
    same as the profile dispatcher. The tools scope to the session tenant via
    ``current_owner_ref()`` internally — the ContextVar is set at session open.
    """
    from api.stock.tools import (
        stock_consume,
        stock_list_donors,
        stock_mark_donor,
        stock_search,
        stock_unmark_donor,
    )

    if name == "stock_search":
        return stock_search(payload)
    if name == "stock_consume":
        return stock_consume(payload)
    if name == "stock_mark_donor":
        return stock_mark_donor(payload)
    if name == "stock_unmark_donor":
        return stock_unmark_donor(payload)
    if name == "stock_list_donors":
        return stock_list_donors(payload)
    logger.warning("unknown stock_* tool: %s", name)
    return {"ok": False, "reason": "unknown-tool"}
