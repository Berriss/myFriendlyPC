#!/usr/bin/env python3
"""
Fetch & sanitize Hololive OCG catalog/prices from TCGCSV (categoryId=87) and
sync them incrementally to Cloud Firestore (`editions/*`, `metadata/catalog`,
`metadata/prices`, `metadata/audit`).

Usage:
  python3 scripts/sync_tcgcsv_to_firestore.py [--from-local-resources] [--force-editions] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fetch_and_sanitize_tcgcsv as tcgcsv
from firebase_admin_helper import init_firestore_client

ROOT_DIR = SCRIPT_DIR.parent
RESOURCES_DIR = ROOT_DIR / "resources"

MIN_EDITIONS_SANITY = 20
MIN_PRODUCTS_SANITY = 1500
MAX_DOC_JSON_BYTES = 900_000

PRICE_KEYS = (
    "marketPrice",
    "lowPrice",
    "midPrice",
    "highPrice",
    "directLowPrice",
    "foilMarketPrice",
    "foilLowPrice",
)

OMIT_IN_SLIM_CARD = {
    "rawDescription",
    "groupId",
    "editionName",
    "editionAbbr",
    "modifiedOn",
    *PRICE_KEYS,
}


def sha256_json(obj: Any) -> str:
    payload = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def slim_card_for_edition(card: dict[str, Any]) -> dict[str, Any]:
    """Strip price/redundant edition fields so per-edition docs stay compact and hash-stable."""
    slim: dict[str, Any] = {}
    for k, v in card.items():
        if k in OMIT_IN_SLIM_CARD:
            continue
        if v is None or v == "" or v is False:
            continue
        slim[k] = v
    return slim


def build_sync_payloads() -> dict[str, Any]:
    groups_path = RESOURCES_DIR / "groups.json"
    cards_path = RESOURCES_DIR / "cards_cleaned.json"
    audit_path = RESOURCES_DIR / "audit_report.json"

    if not groups_path.is_file() or not cards_path.is_file():
        raise FileNotFoundError(
            f"Missing sanitized files in {RESOURCES_DIR}. Run fetch_and_sanitize_tcgcsv.py first."
        )

    groups_data = json.loads(groups_path.read_text(encoding="utf-8"))
    groups = groups_data.get("results") or []
    cards = json.loads(cards_path.read_text(encoding="utf-8"))
    audit_report = json.loads(audit_path.read_text(encoding="utf-8")) if audit_path.is_file() else {}

    if len(groups) < MIN_EDITIONS_SANITY:
        raise RuntimeError(
            f"Sanity check failed: expected >= {MIN_EDITIONS_SANITY} editions, got {len(groups)}"
        )
    if len(cards) < MIN_PRODUCTS_SANITY:
        raise RuntimeError(
            f"Sanity check failed: expected >= {MIN_PRODUCTS_SANITY} products, got {len(cards)}"
        )

    cards_by_group: dict[int, list[dict[str, Any]]] = defaultdict(list)
    prices_map: dict[str, list[Any]] = {}
    total_cards = 0
    total_sealed = 0

    for item in cards:
        gid = int(item["groupId"])
        pid = int(item["productId"])
        if item.get("itemCategory") == "sealed":
            total_sealed += 1
        else:
            total_cards += 1
        cards_by_group[gid].append(slim_card_for_edition(item))
        prices_map[str(pid)] = [item.get(k) for k in PRICE_KEYS]

    editions_docs: list[dict[str, Any]] = []
    edition_hashes: dict[str, str] = {}

    for group in groups:
        gid = int(group["groupId"])
        ed_cards = sorted(cards_by_group.get(gid, []), key=lambda c: int(c["productId"]))
        card_count = sum(1 for c in ed_cards if c.get("itemCategory", "card") == "card")
        sealed_count = sum(1 for c in ed_cards if c.get("itemCategory") == "sealed")

        meta_for_hash = {
            "groupId": gid,
            "name": str(group.get("name", "")),
            "abbreviation": str(group.get("abbreviation", "")),
            "isSupplemental": bool(group.get("isSupplemental", False)),
            "publishedOn": str(group.get("publishedOn", "")),
        }
        ed_hash = sha256_json({"meta": meta_for_hash, "cards": ed_cards})
        cards_json = json.dumps(ed_cards, ensure_ascii=False, separators=(",", ":"))
        cards_bytes = len(cards_json.encode("utf-8"))
        if cards_bytes >= MAX_DOC_JSON_BYTES:
            raise RuntimeError(
                f"Edition {gid} ({meta_for_hash['name']}) cardsJson is {cards_bytes} bytes (>= {MAX_DOC_JSON_BYTES})"
            )

        edition_hashes[str(gid)] = ed_hash
        editions_docs.append(
            {
                **meta_for_hash,
                "modifiedOn": str(group.get("modifiedOn", "")),
                "cardCount": card_count,
                "sealedCount": sealed_count,
                "contentHash": ed_hash,
                "cardsJson": cards_json,
                "_cardsBytes": cards_bytes,
            }
        )

    prices_json = json.dumps(prices_map, ensure_ascii=False, separators=(",", ":"))
    prices_bytes = len(prices_json.encode("utf-8"))
    if prices_bytes >= MAX_DOC_JSON_BYTES:
        raise RuntimeError(f"pricesJson is {prices_bytes} bytes (>= {MAX_DOC_JSON_BYTES})")

    catalog_hash = sha256_json(sorted(edition_hashes.items()))
    audit_json = json.dumps(audit_report, ensure_ascii=False, separators=(",", ":"))

    return {
        "editions_docs": editions_docs,
        "edition_hashes": edition_hashes,
        "edition_ids": [d["groupId"] for d in editions_docs],
        "catalog_hash": catalog_hash,
        "prices_json": prices_json,
        "prices_bytes": prices_bytes,
        "prices_count": len(prices_map),
        "audit_json": audit_json,
        "total_products": len(cards),
        "total_cards": total_cards,
        "total_sealed": total_sealed,
    }


def push_to_firestore(
    payload: dict[str, Any],
    force_editions: bool,
    service_account: str | None,
    project_id: str | None,
) -> dict[str, Any]:
    db, resolved_project = init_firestore_client(service_account, project_id)
    now_iso = datetime.now(timezone.utc).isoformat()

    catalog_ref = db.collection("metadata").document("catalog")
    prev_catalog_snap = catalog_ref.get()
    prev_catalog = prev_catalog_snap.to_dict() if prev_catalog_snap.exists else {}
    prev_hashes: dict[str, str] = prev_catalog.get("editionHashes") or {}

    editions_written = 0
    editions_skipped = 0

    for ed in payload["editions_docs"]:
        gid_str = str(ed["groupId"])
        if not force_editions and prev_hashes.get(gid_str) == ed["contentHash"]:
            editions_skipped += 1
            continue
        doc_body = {k: v for k, v in ed.items() if not k.startswith("_")}
        doc_body["updatedAt"] = now_iso
        db.collection("editions").document(gid_str).set(doc_body)
        editions_written += 1

    # Always write daily prices
    db.collection("metadata").document("prices").set(
        {
            "updatedAt": now_iso,
            "source": f"https://tcgcsv.com/tcgplayer/{tcgcsv.CATEGORY_ID}",
            "count": payload["prices_count"],
            "pricesJson": payload["prices_json"],
        }
    )

    # Write audit when catalog changed, missing, or forced
    audit_ref = db.collection("metadata").document("audit")
    catalog_changed = prev_catalog.get("catalogHash") != payload["catalog_hash"]
    if force_editions or catalog_changed or not audit_ref.get().exists:
        audit_ref.set(
            {
                "syncedAt": now_iso,
                "reportJson": payload["audit_json"],
            }
        )

    catalog_updated_at = (
        now_iso
        if (force_editions or catalog_changed or not prev_catalog.get("catalogUpdatedAt"))
        else prev_catalog.get("catalogUpdatedAt")
    )

    catalog_ref.set(
        {
            "schemaVersion": 1,
            "catalogHash": payload["catalog_hash"],
            "editionHashes": payload["edition_hashes"],
            "editionIds": payload["edition_ids"],
            "editionsCount": len(payload["editions_docs"]),
            "totalProducts": payload["total_products"],
            "totalCards": payload["total_cards"],
            "totalSealed": payload["total_sealed"],
            "catalogUpdatedAt": catalog_updated_at,
            "pricesUpdatedAt": now_iso,
            "source": f"https://tcgcsv.com/tcgplayer/{tcgcsv.CATEGORY_ID}",
        }
    )

    return {
        "projectId": resolved_project,
        "editionsWritten": editions_written,
        "editionsSkipped": editions_skipped,
        "pricesCount": payload["prices_count"],
        "catalogChanged": catalog_changed,
        "catalogHash": payload["catalog_hash"],
        "pricesUpdatedAt": now_iso,
        "catalogUpdatedAt": catalog_updated_at,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync TCGCSV Hololive OCG data & prices to Cloud Firestore.")
    parser.add_argument("--from-local-resources", action="store_true", help="Read existing resources/ without fetching tcgcsv.com")
    parser.add_argument("--force-editions", action="store_true", help="Rewrite all edition documents even if contentHash matches")
    parser.add_argument("--dry-run", action="store_true", help="Validate payloads and print stats without writing to Firestore")
    parser.add_argument("--service-account", default=None, help="Path to Firebase Service Account JSON")
    parser.add_argument("--project-id", default=None, help="Firebase project ID override")
    args = parser.parse_args()

    if not args.from_local_resources:
        tcgcsv.fetch_all()
        tcgcsv.sanitize_all()

    payload = build_sync_payloads()
    max_ed = max(payload["editions_docs"], key=lambda d: d["_cardsBytes"])

    if args.dry_run:
        summary = {
            "dryRun": True,
            "editionsCount": len(payload["editions_docs"]),
            "totalProducts": payload["total_products"],
            "totalCards": payload["total_cards"],
            "totalSealed": payload["total_sealed"],
            "largestEdition": {
                "groupId": max_ed["groupId"],
                "name": max_ed["name"],
                "cardsBytes": max_ed["_cardsBytes"],
            },
            "pricesCount": payload["prices_count"],
            "pricesBytes": payload["prices_bytes"],
            "catalogHash": payload["catalog_hash"],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    result = push_to_firestore(
        payload=payload,
        force_editions=args.force_editions,
        service_account=args.service_account,
        project_id=args.project_id,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
