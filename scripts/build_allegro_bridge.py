#!/usr/bin/env python3
"""Build the bundled Allegro bridge with esbuild 0.25.12 (development only).

Usage: python3 scripts/build_allegro_bridge.py --esbuild /path/to/esbuild
The runtime only needs Node >=18; no npm or TypeScript installation is needed.
"""

import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--esbuild", default="esbuild")
args = parser.parse_args()
version = subprocess.check_output([args.esbuild, "--version"], text=True).strip()
if version != "0.25.12":
    raise SystemExit(f"Expected esbuild 0.25.12, got {version}")
folder = "api/board/parser/_boardripper"
subprocess.run(
    [
        args.esbuild,
        f"{folder}/bridge.ts",
        "--bundle",
        "--platform=node",
        "--target=node18",
        "--format=cjs",
        "--legal-comments=inline",
        "--banner:js=/* BoardRipper-derived Allegro importer: AGPL-3.0. See LICENSE, NOTICE.md and upstream.json alongside this file. */",
        f"--outfile={folder}/bridge.cjs",
    ],
    cwd=ROOT,
    check=True,
)
