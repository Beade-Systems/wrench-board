"""CLI: print a one-line JSON scorecard for the simulator + hypothesize stack.

Usage:
  python -m scripts.eval_simulator --device mnt-reform-motherboard
  python -m scripts.eval_simulator --device mnt-reform-motherboard --verbose
  python -m scripts.eval_simulator --device mnt-reform-motherboard --bench benchmark/scenarios.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from api.config import get_settings
from api.pipeline.schematic.evaluator import compute_score
from api.pipeline.schematic.schemas import AnalyzedBootSequence, ElectricalGraph


def _load_bench(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--device",
        default="mnt-reform-motherboard",
        help="device_slug (memory/{slug}/). Default: mnt-reform-motherboard.",
    )
    parser.add_argument(
        "--bench",
        default="benchmark/scenarios.jsonl",
        help="Path to the frozen bench JSONL (default: benchmark/scenarios.jsonl)",
    )
    parser.add_argument(
        "--compiler-boot",
        action="store_true",
        help="Ignore boot_sequence_analyzed.json and score the compiler-fallback boot.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Include per_scenario breakdown in the JSON output.",
    )
    args = parser.parse_args()

    settings = get_settings()
    graph_path = Path(settings.memory_root) / args.device / "electrical_graph.json"
    if not graph_path.exists():
        print(json.dumps({"error": f"missing graph: {graph_path}"}))
        return 2

    graph = ElectricalGraph.model_validate_json(graph_path.read_text())
    # Score the boot the diagnostic runtime actually uses: the Opus-refined
    # analyzed boot when present, the compiler fallback otherwise.
    boot_path = graph_path.parent / "boot_sequence_analyzed.json"
    analyzed_boot = (
        AnalyzedBootSequence.model_validate_json(boot_path.read_text())
        if boot_path.exists() and not args.compiler_boot
        else None
    )
    scenarios = _load_bench(Path(args.bench))
    sc = compute_score(graph, scenarios, analyzed_boot=analyzed_boot)
    payload = {
        "score": sc.score,
        "self_mrr": sc.self_mrr,
        "cascade_recall": sc.cascade_recall,
        "n_scenarios": sc.n_scenarios,
        "boot": "analyzed" if analyzed_boot is not None else "compiler",
    }
    if args.verbose:
        payload["per_scenario"] = [r.model_dump() for r in sc.per_scenario]
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
