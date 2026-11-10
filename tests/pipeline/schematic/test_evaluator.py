"""Coverage for api/pipeline/schematic/evaluator.py."""

from __future__ import annotations

import pytest

from api.pipeline.schematic.evaluator import (
    Scorecard,
    compute_cascade_recall,
    compute_score,
    compute_self_mrr,
)
from api.pipeline.schematic.schemas import (
    ComponentNode,
    ElectricalGraph,
    NetNode,
    PagePin,
    PowerRail,
    SchematicQualityReport,
)


@pytest.fixture
def trivial_graph() -> ElectricalGraph:
    return ElectricalGraph(
        device_slug="trivial",
        components={
            "U7": ComponentNode(refdes="U7", type="ic"),
            "U12": ComponentNode(
                refdes="U12",
                type="ic",
                pins=[PagePin(number="1", role="power_in", net_label="+5V")],
            ),
        },
        nets={"+5V": NetNode(label="+5V", is_power=True)},
        power_rails={
            "+5V": PowerRail(label="+5V", source_refdes="U7", consumers=["U12"])
        },
        typed_edges=[],
        boot_sequence=[],
        designer_notes=[],
        ambiguities=[],
        quality=SchematicQualityReport(total_pages=1, pages_parsed=1),
    )


def test_compute_self_mrr_returns_float_in_range(trivial_graph):
    score = compute_self_mrr(trivial_graph)
    assert 0.0 <= score <= 1.0


def test_compute_self_mrr_returns_zero_when_no_pairs_sampled():
    empty = ElectricalGraph(
        device_slug="empty",
        components={},
        nets={},
        power_rails={},
        typed_edges=[],
        boot_sequence=[],
        designer_notes=[],
        ambiguities=[],
        quality=SchematicQualityReport(total_pages=0, pages_parsed=0),
    )
    assert compute_self_mrr(empty) == 0.0


def test_compute_cascade_recall_perfect_match(trivial_graph):
    scenarios = [
        {
            "id": "kill_u7",
            "device_slug": "trivial",
            "cause": {"refdes": "U7", "mode": "dead"},
            "expected_dead_rails": ["+5V"],
            "expected_dead_components": ["U12"],
        }
    ]
    recall, breakdown = compute_cascade_recall(trivial_graph, scenarios)
    assert recall == 1.0
    assert len(breakdown) == 1


def test_compute_cascade_recall_zero_when_predictions_disjoint(trivial_graph):
    scenarios = [
        {
            "id": "phantom",
            "device_slug": "trivial",
            "cause": {"refdes": "U7", "mode": "dead"},
            "expected_dead_rails": ["NONEXISTENT"],
            "expected_dead_components": ["NOPE"],
        }
    ]
    recall, _ = compute_cascade_recall(trivial_graph, scenarios)
    assert recall == 0.0


def test_compute_score_honours_60_40_weighting(trivial_graph):
    sc: Scorecard = compute_score(trivial_graph, scenarios=[])
    # Empty scenarios → cascade_recall = 0.0 → score = 0.6 × self_mrr.
    assert pytest.approx(sc.score, abs=1e-6) == 0.6 * sc.self_mrr
    assert sc.cascade_recall == 0.0


def test_compute_self_mrr_is_deterministic(trivial_graph):
    a = compute_self_mrr(trivial_graph)
    b = compute_self_mrr(trivial_graph)
    assert a == b


_KILL_U7 = {
    "id": "kill_u7",
    "device_slug": "trivial",
    "cause": {"refdes": "U7", "mode": "dead"},
    "expected_dead_rails": ["+5V"],
    "expected_dead_components": ["U12"],
}


def test_cascade_breakdown_fills_self_mrr_contribution(trivial_graph):
    _, breakdown = compute_cascade_recall(trivial_graph, [_KILL_U7])
    # U7 dead is the unique cause of "+5V off + U12 dead" → rank 1.
    assert breakdown[0].self_mrr_contribution == pytest.approx(1.0)


def test_self_mrr_contribution_ranks_causes_outside_sampled_modes(trivial_graph):
    """`shorted` is not a sampled mode for an IC; the scenario's own cause
    is still a candidate, so the contribution is not forced to 0."""
    scenario = {**_KILL_U7, "id": "short_u12", "cause": {"refdes": "U12", "mode": "shorted"}}
    _, breakdown = compute_cascade_recall(trivial_graph, [scenario])
    assert breakdown[0].self_mrr_contribution > 0.0


def test_compute_score_threads_analyzed_boot_to_every_simulation(trivial_graph, monkeypatch):
    from api.pipeline.schematic import evaluator
    from api.pipeline.schematic.schemas import AnalyzedBootPhase, AnalyzedBootSequence

    boot = AnalyzedBootSequence(
        device_slug="trivial",
        phases=[
            AnalyzedBootPhase(index=1, name="p", kind="always-on",
                              rails_stable=["+5V"], components_entering=["U7", "U12"]),
        ],
        global_confidence=0.9,
        model_used="test",
    )
    seen: list[object] = []
    real = evaluator.SimulationEngine

    def spy(graph, **kw):
        seen.append(kw.get("analyzed_boot"))
        return real(graph, **kw)

    monkeypatch.setattr(evaluator, "SimulationEngine", spy)
    evaluator.compute_score(trivial_graph, [_KILL_U7], analyzed_boot=boot)
    assert seen and all(b is boot for b in seen)

    seen.clear()
    evaluator.compute_score(trivial_graph, [_KILL_U7])
    assert seen and all(b is None for b in seen)


def test_cascade_recall_counts_consumers_implied_by_expected_dead_rails(trivial_graph, monkeypatch):
    """The oracle lists only `+5V`; U12 sits on it, so a simulator that
    drops U12 from the cascade must lose component recall."""
    from api.pipeline.schematic import evaluator

    scenario = {**_KILL_U7, "expected_dead_components": []}
    recall, _ = compute_cascade_recall(trivial_graph, [scenario])
    assert recall == 1.0

    real = evaluator.SimulationEngine

    class _DropConsumers:
        def __init__(self, graph, **kw):
            self._engine = real(graph, **kw)

        def run(self):
            tl = self._engine.run()
            return tl.model_copy(update={"cascade_dead_components": ["U7"]})

    monkeypatch.setattr(evaluator, "SimulationEngine", _DropConsumers)
    recall, _ = compute_cascade_recall(trivial_graph, [scenario])
    # rails 1/1, components 0/1 (U12 implied) → 0.5.
    assert recall == pytest.approx(0.5)
