"""Cascade must be a transitive fixpoint over rail → consumer → rail chains.

Regression: `_cascade` used to run its dead-rail pass once before the
consumer pass, so a passive (filter bead / inductor) or LDO killed in the
consumer pass that itself sources a further rail never propagated. On
mnt-reform this missed e.g. VOUT/INTVCC behind F1 and VCC/EDP_BL_VCC behind U7.
"""

from __future__ import annotations

from api.pipeline.schematic.schemas import (
    AnalyzedBootPhase,
    AnalyzedBootSequence,
    BootPhase,
    ComponentNode,
    ElectricalGraph,
    NetNode,
    PagePin,
    PowerRail,
    SchematicQualityReport,
)
from api.pipeline.schematic.simulator import SimulationEngine


def _chain_graph() -> ElectricalGraph:
    """VIN → A → R1 → P1 (bead) → R2 → P2 (inductor) → R3 → C.

    Only A (and VIN/R1) are scheduled in the boot sequence; the passives,
    their rails and C never enter a phase (as with real analyzer omissions),
    so they stay "off" and only the cascade can mark them dead.
    """
    comps = {
        "A": ComponentNode(refdes="A", type="ic", pins=[
            PagePin(number="1", role="power_in", net_label="VIN"),
            PagePin(number="2", role="power_out", net_label="R1"),
        ]),
        "P1": ComponentNode(refdes="P1", type="ferrite", pins=[
            PagePin(number="1", role="power_in", net_label="R1"),
            PagePin(number="2", role="power_out", net_label="R2"),
        ]),
        "P2": ComponentNode(refdes="P2", type="inductor", pins=[
            PagePin(number="1", role="power_in", net_label="R2"),
            PagePin(number="2", role="power_out", net_label="R3"),
        ]),
        "C": ComponentNode(refdes="C", type="ic", pins=[
            PagePin(number="1", role="power_in", net_label="R3"),
        ]),
    }
    nets = {n: NetNode(label=n, is_power=True) for n in ("VIN", "R1", "R2", "R3")}
    rails = {
        "VIN": PowerRail(label="VIN", source_refdes=None, consumers=["A"]),
        "R1": PowerRail(label="R1", source_refdes="A", consumers=["P1"]),
        "R2": PowerRail(label="R2", source_refdes="P1", consumers=["P2"]),
        "R3": PowerRail(label="R3", source_refdes="P2", consumers=["C"]),
    }
    return ElectricalGraph(
        device_slug="fixpoint-chain",
        components=comps,
        nets=nets,
        power_rails=rails,
        typed_edges=[],
        boot_sequence=[
            BootPhase(index=1, name="p0", rails_stable=["VIN", "R1"], components_entering=["A"]),
        ],
        quality=SchematicQualityReport(total_pages=1, pages_parsed=1, confidence_global=1.0),
    )


def _analyzed() -> AnalyzedBootSequence:
    return AnalyzedBootSequence(
        device_slug="fixpoint-chain",
        phases=[
            AnalyzedBootPhase(index=1, name="p0", kind="always-on",
                              rails_stable=["VIN", "R1"], components_entering=["A"]),
        ],
        global_confidence=0.9,
        model_used="test",
    )


def test_kill_source_propagates_through_passive_chain_compiler_boot():
    tl = SimulationEngine(_chain_graph(), killed_refdes=["A"]).run()
    assert set(tl.cascade_dead_rails) == {"R1", "R2", "R3"}
    assert {"A", "P1", "P2", "C"} <= set(tl.cascade_dead_components)


def test_kill_source_propagates_through_passive_chain_analyzed_boot():
    tl = SimulationEngine(_chain_graph(), analyzed_boot=_analyzed(), killed_refdes=["A"]).run()
    assert set(tl.cascade_dead_rails) == {"R1", "R2", "R3"}
    assert {"A", "P1", "P2", "C"} <= set(tl.cascade_dead_components)
    # Last-state projection mirrors the cascade.
    last = tl.states[-1]
    assert last.rails["R3"] == "off"
    assert last.components["C"] == "dead"


def test_kill_mid_chain_leaves_upstream_alive():
    tl = SimulationEngine(_chain_graph(), analyzed_boot=_analyzed(), killed_refdes=["P1"]).run()
    assert set(tl.cascade_dead_rails) == {"R2", "R3"}
    assert "R1" not in tl.cascade_dead_rails
    assert "A" not in tl.cascade_dead_components


def test_healthy_chain_has_no_cascade():
    tl = SimulationEngine(_chain_graph(), analyzed_boot=_analyzed()).run()
    assert tl.cascade_dead_rails == []
    assert tl.cascade_dead_components == []
