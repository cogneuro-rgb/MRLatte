#!/usr/bin/env python
"""Isolated worker: the round-trip + neuropythy atlas validation
(tools/scripts/validate_round_trip.py).

neuropythy and nilearn come from one-click modules (validation-neuropythy,
reports-figures). Running here, not in the server, keeps them out of the
server process, so once the check is done nothing holds their files and the
module store can remove them at once (see longitudinal_worker.py).

Usage: python validation_worker.py <config_json_path>
Config: scripts_dir (holds validate_round_trip.py), atlas_dir, sys_path.
Output: one JSON line on stdout; progress and tracebacks on stderr.
"""
import json
import sys
from pathlib import Path


def main():
    # validate_round_trip prints its progress: keep stdout for the result line.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    cfg = json.loads(Path(sys.argv[1]).read_text())
    for p in [*(cfg.get("sys_path") or []), cfg["scripts_dir"]]:
        if p not in sys.path:
            sys.path.insert(0, p)
    from validate_round_trip import run
    real_stdout.write(json.dumps(run(cfg["atlas_dir"])) + "\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
