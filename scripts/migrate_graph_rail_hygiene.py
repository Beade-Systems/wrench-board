#!/usr/bin/env python3
"""Pure-JSON rail-hygiene migration for compiled `electrical_graph.json` files.

Brings graphs compiled before two compiler fixes in line with them, without a
re-compile (a re-compile would also pick up unrelated compiler changes and
shift simulator scores):

  1. Boot `rails_stable` lists only real rails. The compiler-fallback boot
     sequence used to copy the dst of every `powers` edge, so a pass element
     fed by a `powers` edge (mnt-reform: J1->F1, U24->F3) landed in
     rails_stable as if it were a rail.
  2. A power rail whose label is also a component refdes is dropped. Buck
     switch nodes (mnt-reform SW1/SW2) were promoted to rails while switches
     SW1/SW2 exist, so `Observations` rejected the refdes as both component
     and rail. The rail entry is removed, its net loses `is_power`, and every
     boot-phase reference to it goes too.

Scans every `electrical_graph.json` under the memory root (the canonical
`memory/{slug}/` graph and any per-owner `.cache_schematic/{hash}/` copy).
Idempotent: a migrated graph reports no changes. Dry-run by default.

Usage:
    .venv/bin/python scripts/migrate_graph_rail_hygiene.py            # dry run
    .venv/bin/python scripts/migrate_graph_rail_hygiene.py --apply
    .venv/bin/python scripts/migrate_graph_rail_hygiene.py --root memory
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

GRAPH_FILENAME = "electrical_graph.json"


def migrate_graph(graph: dict) -> dict[str, list]:
    """Mutate `graph` in place; return a summary of what changed."""
    components = graph.get("components") or {}
    rails = graph.get("power_rails") or {}
    nets = graph.get("nets") or {}

    colliding = sorted(label for label in rails if label in components)
    for label in colliding:
        del rails[label]
        net = nets.get(label)
        if isinstance(net, dict) and net.get("is_power"):
            net["is_power"] = False

    dropped_stable: list[tuple[int, str]] = []
    for phase in graph.get("boot_sequence") or []:
        stable = phase.get("rails_stable") or []
        kept = [r for r in stable if r in rails]
        for r in stable:
            if r not in rails:
                dropped_stable.append((phase.get("index"), r))
        phase["rails_stable"] = kept

    return {"colliding_rails": colliding, "rails_stable_dropped": dropped_stable}


def _write_atomic(path: Path, payload: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", default="memory", help="memory root to scan (default: memory)")
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = parser.parse_args(argv)

    root = Path(args.root)
    if not root.is_dir():
        print(f"memory root not found: {root}", file=sys.stderr)
        return 2

    paths = sorted(root.rglob(GRAPH_FILENAME))
    if not paths:
        print(f"no {GRAPH_FILENAME} under {root}")
        return 0

    mode = "APPLY" if args.apply else "DRY-RUN"
    changed = 0
    for path in paths:
        graph = json.loads(path.read_text(encoding="utf-8"))
        summary = migrate_graph(graph)
        if not summary["colliding_rails"] and not summary["rails_stable_dropped"]:
            print(f"[{mode}] {path}: clean")
            continue
        changed += 1
        print(f"[{mode}] {path}:")
        if summary["colliding_rails"]:
            print(f"  - power_rails dropped (label is a component refdes): {summary['colliding_rails']}")
        for index, label in summary["rails_stable_dropped"]:
            print(f"  - boot phase {index}: rails_stable drops {label!r}")
        if args.apply:
            _write_atomic(path, graph)
    verb = "migrated" if args.apply else "would migrate"
    print(f"{verb} {changed}/{len(paths)} graph(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
