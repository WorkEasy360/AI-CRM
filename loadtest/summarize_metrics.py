"""Summarise a collect_metrics.sh CSV (long format: timestamp,source,metric,value) into peak/average per series.

    python loadtest/summarize_metrics.py loadtest/results/metrics-20260913T063255Z.csv [--from ISO] [--to ISO]
"""

from __future__ import annotations

import argparse
import csv
import re
from collections import defaultdict

_UNIT = re.compile(r"^([0-9.]+)\s*([A-Za-z%]*)$")
_SCALE = {"B": 1 / 1024**2, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "kB": 1 / 1024, "MB": 1, "GB": 1024, "K": 1 / 1024, "M": 1, "G": 1024}


def _number(raw: str) -> float | None:
    raw = raw.strip()
    m = _UNIT.match(raw)
    if not m:
        return None
    value, unit = float(m.group(1)), m.group(2)
    if unit in _SCALE:
        return value * _SCALE[unit]  # memory in MiB
    return value


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--from", dest="start", default="")
    ap.add_argument("--to", dest="end", default="")
    args = ap.parse_args()
    series: dict[tuple[str, str], list[float]] = defaultdict(list)
    with open(args.csv, newline="", encoding="utf-8") as fh:
        for row in csv.reader(fh):
            if len(row) != 4 or row[0] == "timestamp":
                continue
            ts, source, metric, value = row
            if args.start and ts < args.start or args.end and ts > args.end:
                continue
            n = _number(value)
            if n is not None:
                series[(source, metric)].append(n)
    print(f"{'source':34} {'metric':22} {'samples':>7} {'avg':>10} {'max':>10}")
    for (source, metric), values in sorted(series.items()):
        avg = sum(values) / len(values)
        print(f"{source:34} {metric:22} {len(values):>7} {avg:>10.2f} {max(values):>10.2f}")


if __name__ == "__main__":
    main()
