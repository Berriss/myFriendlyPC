#!/usr/bin/env python3
"""
Fetch today's official USD -> CLP exchange rate (`mindicador.cl` with fallback
to `open.er-api.com`) and sync it to Cloud Firestore (`metadata/exchangeRate`)
plus `resources/exchange_rate.json`.

Usage:
  python3 scripts/sync_clp_rate_to_firestore.py [--from-local-resources] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fetch_clp_rate
from firebase_admin_helper import init_firestore_client

ROOT_DIR = SCRIPT_DIR.parent
RATE_PATH = ROOT_DIR / "resources" / "exchange_rate.json"

MIN_SANE_CLP_RATE = 100.0
MAX_SANE_CLP_RATE = 10000.0


def validate_rate_payload(payload: dict) -> dict:
    rate = float(payload.get("rateClpPerUsd") or 0)
    if not (MIN_SANE_CLP_RATE <= rate <= MAX_SANE_CLP_RATE):
        raise RuntimeError(
            f"Exchange rate sanity check failed: rateClpPerUsd={rate} outside [{MIN_SANE_CLP_RATE}, {MAX_SANE_CLP_RATE}]"
        )
    return {
        "rateClpPerUsd": round(rate, 2),
        "source": str(payload.get("source") or "Banco Central de Chile")[:120],
        "observedDate": str(payload.get("observedDate") or "")[:64],
        "updatedAt": str(payload.get("updatedAt") or "")[:64],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync daily USD -> CLP rate to Cloud Firestore.")
    parser.add_argument("--from-local-resources", action="store_true", help="Read existing resources/exchange_rate.json")
    parser.add_argument("--dry-run", action="store_true", help="Validate payload without writing to Firestore")
    parser.add_argument("--service-account", default=None, help="Path to Firebase Service Account JSON")
    parser.add_argument("--project-id", default=None, help="Firebase project ID override")
    args = parser.parse_args()

    if args.from_local_resources:
        if not RATE_PATH.is_file():
            raise FileNotFoundError(f"Missing {RATE_PATH}")
        raw_payload = json.loads(RATE_PATH.read_text(encoding="utf-8"))
    else:
        raw_payload = fetch_clp_rate.get_clp_rate()
        RATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        RATE_PATH.write_text(json.dumps(raw_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    rate_doc = validate_rate_payload(raw_payload)

    if args.dry_run:
        print(json.dumps({"dryRun": True, **rate_doc}, ensure_ascii=False, indent=2))
        return

    db, resolved_project = init_firestore_client(args.service_account, args.project_id)
    db.collection("metadata").document("exchangeRate").set(rate_doc)
    print(json.dumps({"projectId": resolved_project, **rate_doc}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
