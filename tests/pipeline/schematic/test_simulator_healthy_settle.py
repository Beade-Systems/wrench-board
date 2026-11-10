"""Healthy-boot settle: rails the analyzer never scheduled settle on a good board.

Rails with a source start "off" and used to stabilise only when a phase
listed them, so analyzer omissions left rails "off" on a board that booted
fine (7 on mnt-reform). The post-walk settle pass promotes them — but must
never resurrect a rail whose source is dead, or that is overridden/shorted.
"""

from __future__ import annotations

from api.pipeline.schematic.schemas import (
    AnalyzedBootPhase,
    AnalyzedBootSequence,
    ComponentNode,
    ElectricalGraph,
    NetNode,
    PagePin,
    PowerRail,
    SchematicQualityReport,
)
from api.pipeline.schematic.simulator import Failure, RailOverride, SimulationEngine


def _graph() -> ElectricalGraph:
    """VIN → U1 → R1 → L1 (signal-typed pins) → R2 → F1 → R3 → U3.

    U9 sources R9 but has no rail on any input pin, so nothing proves it
    is powered — R9 must stay "off". Only U1 is scheduled by the analyzer.
    """
    comps = {
        "U1": ComponentNode(refdes="U1", type="ic", pins=[
            PagePin(number="1", role="power_in", net_label="VIN"),
            PagePin(number="2", role="power_out", net_label="R1"),
        ]),
        "L1": ComponentNode(refdes="L1", type="inductor", pins=[
            PagePin(number="1", role="signal_in", net_label="R1"),
            PagePin(number="2", role="signal_out", net_label="R2"),
        ]),
        "F1": ComponentNode(refdes="F1", type="fuse", pins=[
            PagePin(number="1", role="power_in", net_label="R2"),
            PagePin(number="2", role="power_out", net_label="R3"),
        ]),
        "U3": ComponentNode(refdes="U3", type="ic", pins=[
            PagePin(number="1", role="power_in", net_label="R3"),
        ]),
        "U9": ComponentNode(refdes="U9", type="ic", pins=[
            PagePin(number="1", role="power_out", net_label="R9"),
            PagePin(number="2", role="signal_in", net_label="SDA"),
        ]),
    }
    nets = {n: NetNode(label=n, is_power=True) for n in ("VIN", "R1", "R2", "R3", "R9")}
    nets["SDA"] = NetNode(label="SDA")
    rails = {
        "VIN": PowerRail(label="VIN", source_refdes=None, consumers=["U1"]),
        "R1": PowerRail(label="R1", source_refdes="U1", consumers=["L1"]),
        "R2": PowerRail(label="R2", source_refdes="L1", consumers=["F1"]),
        "R3": PowerRail(label="R3", source_refdes="F1", consumers=["U3"]),
        "R9": PowerRail(label="R9", source_refdes="U9", consumers=[]),
    }
    return ElectricalGraph(
        device_slug="settle",
        components=comps,
        nets=nets,
        power_rails=rails,
        typed_edges=[],
        boot_sequence=[],
        quality=SchematicQualityReport(total_pages=1, pages_parsed=1, confidence_global=1.0),
    )


def _analyzed() -> AnalyzedBootSequence:
    return AnalyzedBootSequence(
        device_slug="settle",
        phases=[
            AnalyzedBootPhase(index=1, name="p0", kind="always-on",
                              rails_stable=["VIN", "R1"], components_entering=["U1"]),
        ],
        global_confidence=0.9,
        model_used="test",
    )


def _run(**kw):
    return SimulationEngine(_graph(), analyzed_boot=_analyzed(), **kw).run()


def test_healthy_board_settles_unscheduled_rails():
    tl = _run()
    last = tl.states[-1].rails
    assert tl.final_verdict == "completed"
    assert last["R1"] == "stable"
    assert last["R2"] == "stable"  # passive bridge with signal-typed pins
    assert last["R3"] == "stable"  # chained through a power_in passive
    assert last["R9"] == "off"     # no known upstream rail — never invented


def test_killed_source_never_settles():
    tl = _run(killed_refdes=["U1"])
    last = tl.states[-1].rails
    for rail in ("R1", "R2", "R3"):
        assert last[rail] != "stable", rail


def test_killed_unscheduled_passive_never_settles():
    tl = _run(killed_refdes=["L1"])
    last = tl.states[-1].rails
    assert last["R1"] == "stable"
    assert last["R2"] != "stable"
    assert last["R3"] != "stable"
    assert {"R2", "R3"} <= set(tl.cascade_dead_rails)
    assert "U3" in tl.cascade_dead_components


def test_open_failure_on_bridge_never_settles():
    tl = _run(failures=[Failure(refdes="F1", mode="open")])
    assert tl.states[-1].rails["R3"] != "stable"


def test_rail_override_is_respected():
    tl = _run(rail_overrides=[RailOverride(label="R2", state="off")])
    last = tl.states[-1].rails
    assert last["R2"] == "off"
    assert last["R3"] != "stable"  # its only input is the overridden rail


def test_shorted_override_is_not_rewritten():
    tl = _run(rail_overrides=[RailOverride(label="R2", state="shorted")])
    assert tl.states[-1].rails["R2"] == "shorted"


def test_settle_does_not_change_cascade():
    healthy = _run()
    assert healthy.cascade_dead_rails == []
    assert healthy.cascade_dead_components == []
    # Cascade follows power_in pins only, so a kill upstream of the
    # signal-typed L1 stops at R1 — the settle pass must not alter that.
    killed = _run(killed_refdes=["U1"])
    assert killed.cascade_dead_rails == ["R1"]
    assert killed.cascade_dead_components == ["U1"]
    fuse = _run(killed_refdes=["F1"])
    assert fuse.cascade_dead_rails == ["R3"]
    assert fuse.cascade_dead_components == ["F1", "U3"]
