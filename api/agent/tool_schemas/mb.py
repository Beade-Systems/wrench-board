"""MB_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

MB_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "mb_get_component",
        "description": (
            "Look up a component by refdes on the current device. Returns "
            "aggregated info: {found, canonical_name, memory_bank: {...}|null, "
            "board: {...}|null} when found. For unknown refdes returns "
            "{found: false, closest_matches: [...]}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {"type": "string", "description": "e.g. U7, C29, J3100"},
            },
            "required": ["refdes"],
        },
    },
    {
        "type": "custom",
        "name": "mb_get_rules_for_symptoms",
        "description": (
            "Find diagnostic rules matching a list of symptoms, ranked by "
            "symptom overlap + rule confidence."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symptoms": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "max_results": {"type": "integer", "default": 5},
            },
            "required": ["symptoms"],
        },
    },
    {
        "type": "custom",
        "name": "mb_record_finding",
        "description": (
            "Persist a confirmed repair finding so future sessions see it. "
            "Only when the technician explicitly confirms the cause."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {"type": "string"},
                "symptom": {"type": "string"},
                "confirmed_cause": {"type": "string"},
                "mechanism": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["refdes", "symptom", "confirmed_cause"],
        },
    },
    {
        "type": "custom",
        "name": "mb_record_session_log",
        "description": (
            "Write a narrative summary of THIS conversation to the device's "
            "cross-repair log so future sessions on the same device can grep "
            "what was tested / hypothesised / concluded. Distinct from "
            "mb_record_finding (component-grain, only on confirmed cause): "
            "this is conversation-grain and should be called when wrapping "
            "up — user pauses, fix is confirmed, escalates, or session ends "
            "without conclusion. Idempotent on (repair_id, conv_id): "
            "re-calls overwrite. Mirrored to "
            "/mnt/memory/wrench-board-{slug}/conversation_log/."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symptom": {
                    "type": "string",
                    "description": "1-line restatement of the user-reported symptom that drove this session.",
                },
                "outcome": {
                    "type": "string",
                    "enum": ["resolved", "unresolved", "paused", "escalated"],
                    "description": (
                        "resolved = fix confirmed; unresolved = ended without "
                        "conclusion; paused = user will resume; escalated = "
                        "beyond bench scope (board-replace, vendor RMA)."
                    ),
                },
                "tested": {
                    "type": "array",
                    "description": "Probes/inspections done. Empty list OK.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "target": {
                                "type": "string",
                                "description": "'rail:<label>' | 'comp:<refdes>' | 'pin:<refdes>:<pin>'",
                            },
                            "result": {
                                "type": "string",
                                "description": "Free-form short verdict: 'normal', 'dead', '0V', 'shorted', 'open', 'hot', 'noisy', '3.27V (nom 3.30V)', …",
                            },
                        },
                        "required": ["target", "result"],
                    },
                },
                "hypotheses": {
                    "type": "array",
                    "description": "Suspect refdes considered during the session, with verdict.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "refdes": {"type": "string"},
                            "verdict": {
                                "type": "string",
                                "enum": ["confirmed", "rejected", "inconclusive"],
                            },
                            "evidence": {
                                "type": "string",
                                "description": "One short sentence — the measurement or reasoning that drove the verdict.",
                            },
                        },
                        "required": ["refdes", "verdict"],
                    },
                },
                "findings": {
                    "type": "array",
                    "description": "report_id values returned by mb_record_finding during this session — link them so the narrative cross-references the canonical findings.",
                    "items": {"type": "string"},
                },
                "next_steps": {
                    "type": "string",
                    "description": "If outcome=unresolved or paused: what the next session should pick up.",
                },
                "lesson": {
                    "type": "string",
                    "description": "One-line takeaway for future repairs on this device. Most useful field for grep-based recall.",
                },
            },
            "required": ["symptom", "outcome"],
        },
    },
    {
        "type": "custom",
        "name": "mb_schematic_graph",
        "description": (
            "Interrogate the compiled electrical graph (rails, ICs, enable "
            "signals, boot sequence). Deterministic, no LLM cost. Use BEFORE "
            "speculating on power topology. Queries: "
            "'rail'+label → source_refdes, enable_net, consumers, boot_phase; "
            "'component'+refdes → pins, rails_produced, rails_consumed, "
            "boot_phase; "
            "'downstream'+refdes → transitive loss-of-power set if that "
            "component dies; "
            "'boot_phase'+index → that phase's rails+components; "
            "'list_rails'/'list_boot' → brief catalogues; "
            "'critical_path' → SPOFs ranked by blast_radius + critical gate "
            "per boot phase. Use BEFORE picking the first probe point on a "
            "dead rail; "
            "'net'+label → domain + touching components; "
            "'net_domain'+domain ('hdmi','usb','audio'…) → nets in that "
            "domain + top-3 suspect refdes. Use when the tech describes a "
            "symptom by function (e.g. 'HDMI black screen', 'USB-C dead'). "
            "Returns {found:false, reason:'no_schematic_graph'} if not "
            "ingested — don't retry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "enum": [
                        "rail",
                        "component",
                        "downstream",
                        "boot_phase",
                        "list_rails",
                        "list_boot",
                        "critical_path",
                        "net",
                        "net_domain",
                    ],
                },
                "label": {
                    "type": "string",
                    "description": "Rail or net label, e.g. '+5V', '+3V3', '24V_IN', 'HDMI_HPD'. Required for query=rail or query=net.",
                },
                "refdes": {
                    "type": "string",
                    "description": "Component refdes, e.g. 'U7'. Required for query=component or query=downstream.",
                },
                "domain": {
                    "type": "string",
                    "description": "Functional domain for query=net_domain. Canonical values: hdmi, usb, pcie, ethernet, audio, display, storage, debug, power_seq, power_rail, clock, reset, control, ground. Free-form accepted.",
                },
                "index": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "1-based phase index. Required for query=boot_phase.",
                },
            },
            "required": ["query"],
        },
    },
    {
        "type": "custom",
        "name": "mb_hypothesize",
        "description": (
            "Propose hypotheses (refdes, mode) that explain the "
            "observations. IC modes (active): dead (inert), alive "
            "(working), anomalous (powered but wrong output — DSI "
            "bridge IC, audio codec, sensor), hot (running abnormally "
            "warm). PASSIVE modes (R/C/D/FB): open (broken circuit, "
            "typically burnt ferrite or cracked R), short (plate-to-"
            "plate for a cap, wire for an R). Q modes (MOSFET/BJT): "
            "open / short (physical), stuck_on / stuck_off "
            "(behavioural: always conducting / never conducting). RAIL "
            "modes: dead, alive, shorted, stuck_on (rail powered when "
            "it should be off). Pass at least one observation via "
            "state_comps / state_rails OR provide repair_id to "
            "synthesise from the journal. The response contains "
            "`discriminating_targets` (list[str]): when top-N "
            "candidates tie on score, these are the refdes/rails whose "
            "next measurement best partitions the suspects — surface "
            "them to the tech."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "state_comps": {
                    "type": "object",
                    "description": (
                        "Map refdes → mode. For an IC: 'dead', 'alive', "
                        "'anomalous', 'hot'. For a passive (R/C/D/FB): "
                        "'open', 'short', 'alive'. For a passive_q "
                        "(MOSFET/BJT): 'open', 'short', 'stuck_on', "
                        "'stuck_off', 'alive'. The engine rejects an IC "
                        "in passive mode (and vice versa)."
                    ),
                    "additionalProperties": {
                        "type": "string",
                        "enum": [
                            "dead", "alive", "anomalous", "hot",
                            "open", "short",
                            "stuck_on", "stuck_off",
                        ],
                    },
                },
                "state_rails": {
                    "type": "object",
                    "description": (
                        "Map rail label → mode. Modes: 'dead' (0V), "
                        "'alive' (nominal), 'shorted' (short to GND or "
                        "overvolt), 'stuck_on' (powered when it should "
                        "be off — blown load switch downstream)."
                    ),
                    "additionalProperties": {
                        "type": "string",
                        "enum": ["dead", "alive", "shorted", "stuck_on"],
                    },
                },
                "metrics_comps": {
                    "type": "object",
                    "description": "Optional numeric measurements on components, refdes → {measured, unit, nominal?}.",
                    "additionalProperties": {"type": "object"},
                },
                "metrics_rails": {
                    "type": "object",
                    "description": "Optional numeric measurements on rails.",
                    "additionalProperties": {"type": "object"},
                },
                "max_results": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
                "repair_id": {
                    "type": "string",
                    "description": "If set AND state/metrics dicts are empty, synthesise observations from the repair's measurement journal.",
                },
            },
            "required": [],
        },
    },
    {
        "type": "custom",
        "name": "mb_record_measurement",
        "description": (
            "Record an electrical measurement from the tech into the "
            "repair-session journal. Target format 'rail:<label>' | "
            "'comp:<refdes>' | 'pin:<refdes>:<pin>'. Unit ∈ "
            "{V, A, W, °C, Ω, mV}. If nominal is provided, the mode is "
            "auto-classified (alive/anomalous/dead/shorted/hot)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "value": {"type": "number"},
                "unit": {"type": "string", "enum": ["V", "A", "W", "°C", "Ω", "mV"]},
                "nominal": {"type": ["number", "null"]},
                "note": {"type": ["string", "null"]},
            },
            "required": ["target", "value", "unit"],
        },
    },
    {
        "type": "custom",
        "name": "mb_list_measurements",
        "description": "Re-read the repair-session measurement journal, optionally filtered by target and/or timestamp.",
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": ["string", "null"]},
                "since": {"type": ["string", "null"]},
            },
            "required": [],
        },
    },
    {
        "type": "custom",
        "name": "mb_compare_measurements",
        "description": "Before/after diff of a given target (oldest measurement vs latest by default).",
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "before_ts": {"type": ["string", "null"]},
                "after_ts": {"type": ["string", "null"]},
            },
            "required": ["target"],
        },
    },
    {
        "type": "custom",
        "name": "mb_observations_from_measurements",
        "description": "Synthesise an Observations payload (state + metrics) from the measurement journal — latest event per target.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "type": "custom",
        "name": "mb_set_observation",
        "description": (
            "Force an observation mode for a target without recording a "
            "value (useful when the tech says 'U7 is dead' without a "
            "measurement). Emits the WS event for the UI. "
            "Modes per kind: rail ∈ {dead, alive, shorted, stuck_on}. "
            "IC ∈ {dead, alive, anomalous, hot}. Passive (R/C/D/FB) ∈ "
            "{open, short, alive}. Passive_q (MOSFET/BJT) ∈ {open, short, "
            "stuck_on, stuck_off, alive}. The server rejects a mode that "
            "is inconsistent with the target's kind."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "target": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": [
                        "dead", "alive", "anomalous", "hot", "shorted",
                        "stuck_on", "stuck_off", "open", "short",
                    ],
                },
            },
            "required": ["target", "mode"],
        },
    },
    {
        "type": "custom",
        "name": "mb_clear_observations",
        "description": "Clear the visual observation state on the UI side (the journal is preserved).",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "type": "custom",
        "name": "mb_validate_finding",
        "description": (
            "Record the culprit component(s) confirmed by the tech at "
            "the end of a repair. Call ONLY after a 'Marquer fix' "
            "trigger has been received AND the fixes are confirmed "
            "(no auto-validation on ambiguous context). `fixes` is a "
            "list of objects "
            "{refdes, mode ∈ (dead|alive|anomalous|hot|shorted|passive_swap), rationale}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "fixes": {
                    "type": "array",
                    "description": "List of components fixed during the repair.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "refdes": {"type": "string"},
                            "mode": {
                                "type": "string",
                                "enum": ["dead", "alive", "anomalous", "hot", "shorted", "passive_swap"],
                            },
                            "rationale": {"type": "string"},
                        },
                        "required": ["refdes", "mode", "rationale"],
                    },
                    "minItems": 1,
                },
                "tech_note": {"type": ["string", "null"]},
                "agent_confidence": {
                    "type": "string",
                    "enum": ["high", "medium", "low"],
                    "default": "high",
                },
            },
            "required": ["fixes"],
        },
    },
    {
        "type": "custom",
        "name": "mb_expand_knowledge",
        "description": (
            "Grow this device's memory bank around a focus symptom area. "
            "COSTS ~$0.40 AND 30-60s of wall clock. NEVER call autonomously — "
            "the technician MUST explicitly authorize this call (e.g. reply "
            "'oui', 'go', 'lance'). When mb_get_rules_for_symptoms returns "
            "zero matches, PROPOSE the expansion and wait for the tech's "
            "confirmation. Only then invoke this tool. After it succeeds, "
            "re-call mb_get_rules_for_symptoms to pick up the new rules."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "focus_symptoms": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "description": "Symptom phrases to target, e.g. ['no sound', 'earpiece dead'].",
                },
                "focus_refdes": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional refdes to probe specifically (e.g. ['U3101', 'U3200']).",
                },
            },
            "required": ["focus_symptoms"],
        },
    },
]
