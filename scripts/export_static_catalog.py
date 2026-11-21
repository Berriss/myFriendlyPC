#!/usr/bin/env python3
"""Copy and optimize catalog JSON datasets from resources/ to static/data/ for Firebase Hosting."""

from __future__ import annotations

import json
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
RES_DIR = ROOT_DIR / "resources"
OUT_DIR = ROOT_DIR / "static" / "data"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Compact cards_cleaned.json (minified whitespace for fast Firebase Hosting CDN delivery)
    cards = json.loads((RES_DIR / "cards_cleaned.json").read_text(encoding="utf-8"))
    (OUT_DIR / "cards_cleaned.json").write_text(
        json.dumps(cards, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    for filename in ("groups.json", "audit_report.json", "exchange_rate.json"):
        src = RES_DIR / filename
        if src.exists():
            data = json.loads(src.read_text(encoding="utf-8"))
            (OUT_DIR / filename).write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )

    print(f"Exported static catalog data to {OUT_DIR} ({len(cards)} items)")


if __name__ == "__main__":
    main()
