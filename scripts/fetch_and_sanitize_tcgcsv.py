#!/usr/bin/env python3
"""
Fetcher and sanitizer for Hololive Official Card Game (TCGCSV categoryId = 87).

Usage:
  python3 scripts/fetch_and_sanitize_tcgcsv.py --fetch-only
  python3 scripts/fetch_and_sanitize_tcgcsv.py --sanitize-only
  python3 scripts/fetch_and_sanitize_tcgcsv.py
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

CATEGORY_ID = 87
BASE_URL = f"https://tcgcsv.com/tcgplayer/{CATEGORY_ID}"
USER_AGENT = "HololiveOCGTracker/1.0 (+local-collection-app)"

ROOT_DIR = Path(__file__).resolve().parent.parent
RESOURCES_DIR = ROOT_DIR / "resources"
EDITIONS_DIR = RESOURCES_DIR / "editions"

RARITY_CODE_MAP = {
    "common": "C",
    "uncommon": "U",
    "rare": "R",
    "double rare": "RR",
    "super rare": "SR",
    "ultra rare": "UR",
    "secret rare": "SEC",
    "holomem rare": "HR",
    "oshi common": "OC",
    "oshi super rare": "OSR",
    "oshi ultra rare": "OUR",
    "special": "S",
    "special yell": "SY",
    "promo": "P",
}

ARTS_COLOR_PREFIX_MAP = {
    "W": "White",
    "G": "Green",
    "R": "Red",
    "B": "Blue",
    "P": "Purple",
    "Y": "Yellow",
}


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower()).strip("_")
    return slug[:max_len] if slug else "edition"


def http_get_bytes(url: str, retries: int = 3, timeout: int = 30) -> bytes:
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/csv, */*",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
            if attempt < retries:
                time.sleep(0.8 * attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def fetch_all() -> None:
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)
    EDITIONS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Fetching groups JSON from {BASE_URL}/groups ...")
    groups_raw = http_get_bytes(f"{BASE_URL}/groups")
    groups_data = json.loads(groups_raw.decode("utf-8"))
    (RESOURCES_DIR / "groups.json").write_bytes(groups_raw)

    print(f"Fetching Groups.csv from {BASE_URL}/Groups.csv ...")
    try:
        groups_csv_raw = http_get_bytes(f"{BASE_URL}/Groups.csv")
        (RESOURCES_DIR / "Groups.csv").write_bytes(groups_csv_raw)
    except Exception as exc:
        print(f"Warning: could not fetch Groups.csv directly ({exc}), continuing with groups.json")

    groups = groups_data.get("results", [])
    print(f"Found {len(groups)} editions in category {CATEGORY_ID}.")

    for idx, group in enumerate(groups, start=1):
        group_id = group["groupId"]
        name = group.get("name", f"group_{group_id}")
        abbr = group.get("abbreviation") or ""
        dir_name = f"{group_id}_{slugify(f'{abbr}_{name}' if abbr else name)}"
        edition_dir = EDITIONS_DIR / dir_name
        edition_dir.mkdir(parents=True, exist_ok=True)

        print(f"[{idx}/{len(groups)}] Fetching {group_id} ({name}) -> {edition_dir.name}")
        for filename, endpoint in (
            ("products.json", "products"),
            ("prices.json", "prices"),
            ("ProductsAndPrices.csv", "ProductsAndPrices.csv"),
        ):
            url = f"{BASE_URL}/{group_id}/{endpoint}"
            try:
                payload = http_get_bytes(url)
                (edition_dir / filename).write_bytes(payload)
            except Exception as exc:
                print(f"  Warning: failed {url}: {exc}", file=sys.stderr)
        time.sleep(0.1)

    print("Fetch complete.")


def clean_html_and_spacing(raw: str | None) -> tuple[str, dict[str, bool]]:
    flags = {
        "had_html": False,
        "had_crlf": False,
        "had_spacing_fix": False,
        "had_typo_fix": False,
        "had_comma": False,
        "had_quotes": False,
    }
    if not raw:
        return "", flags

    flags["had_comma"] = "," in raw
    flags["had_quotes"] = '"' in raw
    flags["had_crlf"] = "\r" in raw

    text = raw.replace("\r\n", "\n").replace("\r", "\n")

    if re.search(r"<[^>]+>", text) or "&amp;" in text or "&quot;" in text or "&#" in text:
        flags["had_html"] = True

    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p\s*>", "\n", text)
    text = re.sub(r"(?i)<p[^>]*>", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)

    # Fix TCGplayer bracket/quote typos like: "Stone Axe> -> "Stone Axe", ]green cheers] -> [green cheers]
    typo_fixed = re.sub(r'"([A-Za-z0-9][A-Za-z0-9 \'\-\.!~&]+)>', r'"\1"', text)
    typo_fixed = re.sub(r'(^|\s)\]([A-Za-z0-9][^\[\]]*\])', r'\1[\2', typo_fixed)
    typo_fixed = re.sub(r'([A-Za-z0-9])>', r'\1', typo_fixed)
    if typo_fixed != text:
        flags["had_typo_fix"] = True
    text = typo_fixed

    # Fix common TCGplayer concatenation bugs like "LIMITEDUsable" or '"Gift"Overwrite'
    fixed = re.sub(r"\bLIMITED(?=Usable|You|This|Only|1)", "LIMITED: ", text)
    fixed = re.sub(r'("(?:Gift|Bloom Effect|Collab Effect)")(?=[A-Za-z])', r"\1 ", fixed)
    fixed = re.sub(r"([a-z0-9]):([A-Z])", r"\1: \2", fixed)
    fixed = re.sub(r"\]([A-Z])", r"] \1", fixed)
    if fixed != text:
        flags["had_spacing_fix"] = True
    text = fixed

    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned, flags


def normalize_rarity(raw: str | None, name: str) -> tuple[str, str]:
    val = (raw or "").strip()
    if val:
        code = RARITY_CODE_MAP.get(val.lower(), val)
        return code, val
    m = re.search(r"\((OUR|OSR|SEC|SSR|UR|SR|RR|OC|SY|HR|R|U|C|S|P)\)", name)
    if m:
        code = m.group(1)
        return code, code
    return "", ""


def normalize_card_type(raw: str | None, rarity_name: str, card_number: str, ext_map: dict[str, str], name: str, item_category: str) -> tuple[str, bool]:
    if item_category == "sealed":
        return "Sealed", False

    val = (raw or "").strip()
    if val:
        low = val.lower()
        if low == "oshi holomem":
            return "Oshi Holomem", False
        if low == "buzz holomem":
            return "Buzz Holomem", False
        if low == "holomem":
            return "Holomem", False
        if low == "support":
            return "Support", False
        if low == "cheer":
            return "Cheer", False
        return val, False

    # Infer missing CardType from sibling attributes
    r_low = rarity_name.lower()
    if "oshi" in r_low or "Life" in ext_map or "Oshi Skill" in ext_map or card_number.startswith("hYS"):
        return "Oshi Holomem", True
    if card_number.startswith("hY") or "cheer" in name.lower():
        return "Cheer", True
    if "you get life-2" in (ext_map.get("Special Rules") or "").lower():
        return "Buzz Holomem", True
    if "HP" in ext_map or "Arts 1" in ext_map or "BloomLevel" in ext_map:
        return "Holomem", True
    if "Description" in ext_map or "Subtype" in ext_map:
        return "Support", True
    return "Support", True


def normalize_color(raw: str | None, card_type: str, arts1: str, arts2: str, name: str, item_category: str) -> tuple[str, bool]:
    if item_category == "sealed":
        return "", False

    val = (raw or "").strip()
    if val:
        if val.lower() == "neutral":
            return "Colorless", False
        if ";" in val:
            parts = [p.strip().capitalize() for p in val.split(";") if p.strip()]
            return " / ".join(parts), False
        return val, False

    if card_type == "Support":
        return "Colorless", True

    # Infer from Arts cost brackets like [W], [G], [R], [B], [P], [Y]
    found_colors: list[str] = []
    for bracket in re.findall(r"\[([WGRBPY]+)\]", f"{arts1} {arts2}"):
        for ch in bracket:
            c = ARTS_COLOR_PREFIX_MAP.get(ch)
            if c and c not in found_colors:
                found_colors.append(c)
    if found_colors:
        return " / ".join(found_colors), True

    # Infer from Cheer name
    low_name = name.lower()
    for color_name in ("White", "Green", "Red", "Blue", "Purple", "Yellow"):
        if color_name.lower() in low_name:
            return color_name, True

    return "Colorless", True


def normalize_bloom_level(raw: str | None, card_type: str) -> str:
    val = (raw or "").strip()
    if not val:
        return ""
    low = val.lower()
    if low == "spot":
        return "Spot"
    if low == "debut":
        return "Debut"
    if low in ("1st", "2nd"):
        return low
    return val


def parse_int_field(val: str | None) -> int | None:
    if not val:
        return None
    m = re.search(r"\d+", val)
    return int(m.group(0)) if m else None


def parse_float_field(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def sanitize_all() -> None:
    groups_path = RESOURCES_DIR / "groups.json"
    if not groups_path.exists():
        raise FileNotFoundError(f"Missing {groups_path}. Run --fetch-only first.")

    groups_data = json.loads(groups_path.read_text(encoding="utf-8"))
    groups = {g["groupId"]: g for g in groups_data.get("results", [])}

    edition_dirs = sorted(p for p in EDITIONS_DIR.iterdir() if p.is_dir())
    cleaned_records: list[dict[str, Any]] = []
    seen_product_ids: set[int] = set()

    stats: dict[str, Any] = {
        "editions_processed": 0,
        "total_products": 0,
        "total_cards": 0,
        "total_sealed": 0,
        "csv_rows_parsed": 0,
        "naive_csv_broken_rows": 0,
        "csv_rows_with_commas_in_text": 0,
        "csv_rows_with_newlines_in_text": 0,
        "csv_rows_with_quotes_in_text": 0,
        "descriptions_html_cleaned": 0,
        "spacing_bugs_fixed": 0,
        "typos_fixed": 0,
        "missing_card_type_inferred": 0,
        "missing_color_inferred": 0,
        "csv_vs_json_mismatches_resolved": 0,
        "duplicate_products_skipped": 0,
        "discovered_extended_keys": set(),
        "examples": [],
    }

    for ed_dir in edition_dirs:
        products_file = ed_dir / "products.json"
        prices_file = ed_dir / "prices.json"
        csv_file = ed_dir / "ProductsAndPrices.csv"

        if not products_file.exists():
            continue

        stats["editions_processed"] += 1
        products_payload = json.loads(products_file.read_text(encoding="utf-8"))
        products = products_payload.get("results", [])

        prices_by_pid: dict[int, list[dict[str, Any]]] = {}
        if prices_file.exists():
            prices_payload = json.loads(prices_file.read_text(encoding="utf-8"))
            for pr in prices_payload.get("results", []):
                pid = int(pr["productId"])
                prices_by_pid.setdefault(pid, []).append(pr)

        csv_by_pid: dict[int, list[dict[str, str]]] = {}
        if csv_file.exists():
            raw_csv_text = csv_file.read_text(encoding="utf-8", errors="replace")
            raw_lines = raw_csv_text.splitlines()
            if raw_lines:
                expected_cols = len(raw_lines[0].split(","))
                for line in raw_lines[1:]:
                    if len(line.split(",")) != expected_cols:
                        stats["naive_csv_broken_rows"] += 1

            reader = csv.DictReader(io.StringIO(raw_csv_text, newline=""))
            for row in reader:
                stats["csv_rows_parsed"] += 1
                pid_str = (row.get("productId") or "").strip()
                if not pid_str.isdigit():
                    continue
                pid = int(pid_str)
                csv_by_pid.setdefault(pid, []).append(row)

                text_blobs = [
                    v for k, v in row.items()
                    if v and (k.startswith("ext") or k in ("name", "cleanName"))
                ]
                joined = " ".join(text_blobs)
                if "," in joined:
                    stats["csv_rows_with_commas_in_text"] += 1
                if "\n" in joined or "\r" in joined:
                    stats["csv_rows_with_newlines_in_text"] += 1
                if '"' in joined:
                    stats["csv_rows_with_quotes_in_text"] += 1

        for prod in products:
            pid = int(prod["productId"])
            if pid in seen_product_ids:
                stats["duplicate_products_skipped"] += 1
                continue
            seen_product_ids.add(pid)
            stats["total_products"] += 1

            group_id = int(prod.get("groupId") or 0)
            group_meta = groups.get(group_id, {})
            group_name = group_meta.get("name", ed_dir.name)
            group_abbr = group_meta.get("abbreviation") or ""

            ext_map: dict[str, str] = {}
            for item in prod.get("extendedData") or []:
                k = str(item.get("name") or "").strip()
                v = str(item.get("value") or "").strip()
                if k:
                    ext_map[k] = v
                    stats["discovered_extended_keys"].add(k)

            csv_rows = csv_by_pid.get(pid, [])
            csv_row = csv_rows[0] if csv_rows else {}

            name = str(prod.get("name") or "").strip()
            clean_name = str(prod.get("cleanName") or name).strip()

            raw_rarity = ext_map.get("Rarity") or csv_row.get("extRarity") or ""
            raw_number = ext_map.get("Number") or csv_row.get("extNumber") or ""

            item_category = "card" if (raw_rarity or raw_number or ext_map) else "sealed"
            if item_category == "card":
                stats["total_cards"] += 1
            else:
                stats["total_sealed"] += 1

            rarity_code, rarity_name = normalize_rarity(raw_rarity, name)
            card_number = raw_number.strip()

            card_type, type_inferred = normalize_card_type(
                ext_map.get("CardType") or csv_row.get("extCardType"),
                rarity_name,
                card_number,
                ext_map,
                name,
                item_category,
            )
            if type_inferred:
                stats["missing_card_type_inferred"] += 1

            # Clean all effect text sections
            raw_oshi = ext_map.get("Oshi Skill") or csv_row.get("extOshiSkill") or ""
            raw_sp_oshi = ext_map.get("SP Oshi Skill") or csv_row.get("extSPOshiSkill") or ""
            raw_keyword = ext_map.get("Keyword") or csv_row.get("extKeyword") or ""
            raw_arts1 = ext_map.get("Arts 1") or csv_row.get("extArts1") or ""
            raw_arts2 = ext_map.get("Arts 2") or csv_row.get("extArts2") or ""
            raw_special = ext_map.get("Special Rules") or csv_row.get("extSpecialRules") or ""
            raw_desc = ext_map.get("Description") or csv_row.get("extDescription") or ""

            oshi_skill, f1 = clean_html_and_spacing(raw_oshi)
            sp_oshi_skill, f2 = clean_html_and_spacing(raw_sp_oshi)
            keyword_text, f3 = clean_html_and_spacing(raw_keyword)
            arts1, f4 = clean_html_and_spacing(raw_arts1)
            arts2, f5 = clean_html_and_spacing(raw_arts2)
            special_rules, f6 = clean_html_and_spacing(raw_special)
            description_text, f7 = clean_html_and_spacing(raw_desc)

            all_flags = [f1, f2, f3, f4, f5, f6, f7]
            had_html = any(f["had_html"] for f in all_flags)
            had_spacing_fix = any(f["had_spacing_fix"] for f in all_flags)
            had_typo_fix = any(f["had_typo_fix"] for f in all_flags)
            had_comma = any(f["had_comma"] for f in all_flags)
            had_crlf = any(f["had_crlf"] for f in all_flags)
            had_quotes = any(f["had_quotes"] for f in all_flags)

            if had_html:
                stats["descriptions_html_cleaned"] += 1
            if had_spacing_fix:
                stats["spacing_bugs_fixed"] += 1
            if had_typo_fix:
                stats["typos_fixed"] += 1

            # Compose unified readable effectText
            effect_sections: list[str] = []
            if oshi_skill:
                effect_sections.append(f"Oshi Skill: {oshi_skill}")
            if sp_oshi_skill:
                effect_sections.append(f"SP Oshi Skill: {sp_oshi_skill}")
            if keyword_text:
                effect_sections.append(f"Keyword: {keyword_text}")
            if arts1:
                effect_sections.append(f"Arts 1: {arts1}")
            if arts2:
                effect_sections.append(f"Arts 2: {arts2}")
            if special_rules:
                effect_sections.append(f"Special Rules: {special_rules}")
            if description_text:
                effect_sections.append(description_text)

            effect_text = "\n\n".join(effect_sections)
            raw_combined = " | ".join(
                s for s in (raw_oshi, raw_sp_oshi, raw_keyword, raw_arts1, raw_arts2, raw_special, raw_desc) if s
            )

            # Check if CSV had truncated or differing values vs JSON
            csv_joined = " | ".join(
                s
                for s in (
                    csv_row.get("extOshiSkill") or "",
                    csv_row.get("extSPOshiSkill") or "",
                    csv_row.get("extKeyword") or "",
                    csv_row.get("extArts1") or "",
                    csv_row.get("extArts2") or "",
                    csv_row.get("extSpecialRules") or "",
                    csv_row.get("extDescription") or "",
                )
                if s
            )
            if csv_joined and raw_combined and csv_joined.replace("\r\n", "\n") != raw_combined.replace("\r\n", "\n"):
                stats["csv_vs_json_mismatches_resolved"] += 1

            color, color_inferred = normalize_color(
                ext_map.get("Color") or csv_row.get("extColor"),
                card_type,
                arts1,
                arts2,
                name,
                item_category,
            )
            if color_inferred:
                stats["missing_color_inferred"] += 1

            bloom_level = normalize_bloom_level(
                ext_map.get("BloomLevel") or csv_row.get("extBloomLevel"),
                card_type,
            )
            subtype = (ext_map.get("Subtype") or csv_row.get("extSubtype") or "").strip()
            hp = parse_int_field(ext_map.get("HP") or csv_row.get("extHP"))
            life = parse_int_field(ext_map.get("Life") or csv_row.get("extLife"))
            baton_pass = (ext_map.get("Baton Pass") or csv_row.get("extBatonPass") or "").strip()
            tags = (ext_map.get("Tags") or csv_row.get("extTags") or "").strip()

            # Reconcile prices across Normal and Foil variants
            price_entries = prices_by_pid.get(pid, [])
            normal_price = None
            foil_price = None
            for pe in price_entries:
                sub = str(pe.get("subTypeName") or "Normal")
                if sub.lower() == "foil":
                    foil_price = pe
                elif sub.lower() == "normal":
                    normal_price = pe
                elif normal_price is None:
                    normal_price = pe

            primary_price = normal_price or foil_price or (price_entries[0] if price_entries else {})
            market_price = parse_float_field(primary_price.get("marketPrice") if primary_price else csv_row.get("marketPrice"))
            low_price = parse_float_field(primary_price.get("lowPrice") if primary_price else csv_row.get("lowPrice"))
            mid_price = parse_float_field(primary_price.get("midPrice") if primary_price else csv_row.get("midPrice"))
            high_price = parse_float_field(primary_price.get("highPrice") if primary_price else csv_row.get("highPrice"))
            direct_low_price = parse_float_field(primary_price.get("directLowPrice") if primary_price else csv_row.get("directLowPrice"))

            foil_market_price = parse_float_field(foil_price.get("marketPrice")) if foil_price else None
            foil_low_price = parse_float_field(foil_price.get("lowPrice")) if foil_price else None

            # Ensure market_price falls back to foil_market_price when only Foil exists
            if market_price is None and foil_market_price is not None:
                market_price = foil_market_price
            if low_price is None and foil_low_price is not None:
                low_price = foil_low_price

            price_subtype = str(primary_price.get("subTypeName") or "Normal") if primary_price else "Normal"
            was_sanitized = bool(had_comma or had_html or had_crlf or had_quotes or had_spacing_fix or had_typo_fix or type_inferred or color_inferred)

            record = {
                "productId": pid,
                "groupId": group_id,
                "editionName": group_name,
                "editionAbbr": group_abbr,
                "name": name,
                "cleanName": clean_name,
                "imageUrl": str(prod.get("imageUrl") or "").strip(),
                "url": str(prod.get("url") or "").strip(),
                "itemCategory": item_category,
                "cardNumber": card_number,
                "rarity": rarity_code,
                "rarityName": rarity_name,
                "cardType": card_type,
                "subtype": subtype,
                "color": color,
                "bloomLevel": bloom_level,
                "hp": hp,
                "life": life,
                "batonPass": baton_pass,
                "tags": tags,
                "oshiSkill": oshi_skill,
                "spOshiSkill": sp_oshi_skill,
                "keywordText": keyword_text,
                "arts1": arts1,
                "arts2": arts2,
                "specialRules": special_rules,
                "descriptionText": description_text,
                "effectText": effect_text,
                "rawDescription": raw_combined,
                "marketPrice": market_price,
                "lowPrice": low_price,
                "midPrice": mid_price,
                "highPrice": high_price,
                "directLowPrice": direct_low_price,
                "foilMarketPrice": foil_market_price,
                "foilLowPrice": foil_low_price,
                "priceSubtype": price_subtype,
                "sanitizedFlag": was_sanitized,
                "hadCommaOrHtml": bool(had_comma or had_html),
                "modifiedOn": str(prod.get("modifiedOn") or "").strip(),
            }
            cleaned_records.append(record)

            if (had_comma or had_html or had_spacing_fix or had_typo_fix or type_inferred) and len(stats["examples"]) < 15:
                stats["examples"].append(
                    {
                        "productId": pid,
                        "name": name,
                        "cardNumber": card_number,
                        "issuesFixed": [
                            tag
                            for cond, tag in (
                                (had_comma, "comma_in_effect_text"),
                                (had_html, "html_tags_stripped"),
                                (had_crlf, "multiline_crlf_normalized"),
                                (had_quotes, "embedded_quotes_escaped"),
                                (had_spacing_fix, "missing_space_after_label"),
                                (had_typo_fix, "bracket_quote_typo_repaired"),
                                (type_inferred, "missing_card_type_inferred"),
                                (color_inferred, "missing_color_inferred"),
                            )
                            if cond
                        ],
                        "rawSnippet": raw_combined[:260],
                        "cleanedSnippet": effect_text[:260],
                    }
                )

    stats["discovered_extended_keys"] = sorted(stats["discovered_extended_keys"])

    (RESOURCES_DIR / "cards_cleaned.json").write_text(
        json.dumps(cleaned_records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    csv_fields = [
        "productId",
        "groupId",
        "editionName",
        "editionAbbr",
        "name",
        "cleanName",
        "itemCategory",
        "cardNumber",
        "rarity",
        "rarityName",
        "cardType",
        "subtype",
        "color",
        "bloomLevel",
        "hp",
        "life",
        "batonPass",
        "tags",
        "marketPrice",
        "lowPrice",
        "midPrice",
        "highPrice",
        "foilMarketPrice",
        "foilLowPrice",
        "priceSubtype",
        "effectText",
        "imageUrl",
        "url",
        "sanitizedFlag",
    ]
    with (RESOURCES_DIR / "cards_cleaned.csv").open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=csv_fields, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writeheader()
        for rec in cleaned_records:
            writer.writerow({k: "" if rec.get(k) is None else rec.get(k) for k in csv_fields})

    (RESOURCES_DIR / "audit_report.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("Sanitization summary:")
    print(f"  Editions processed: {stats['editions_processed']}")
    print(f"  Total products: {stats['total_products']} (cards={stats['total_cards']}, sealed={stats['total_sealed']})")
    print(f"  CSV rows parsed (RFC-4180): {stats['csv_rows_parsed']}")
    print(f"  CSV lines broken under naive comma split: {stats['naive_csv_broken_rows']}")
    print(f"  CSV rows with commas in effect/text: {stats['csv_rows_with_commas_in_text']}")
    print(f"  Descriptions HTML cleaned: {stats['descriptions_html_cleaned']}")
    print(f"  Spacing bugs fixed (e.g. LIMITEDUsable): {stats['spacing_bugs_fixed']}")
    print(f"  Missing CardType inferred: {stats['missing_card_type_inferred']}")
    print(f"  Missing Color inferred: {stats['missing_color_inferred']}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch & sanitize Hololive OCG TCGCSV data.")
    parser.add_argument("--fetch-only", action="store_true", help="Only download raw JSON and CSV files to resources/")
    parser.add_argument("--sanitize-only", action="store_true", help="Only sanitize already downloaded files in resources/")
    args = parser.parse_args()

    if args.fetch_only and args.sanitize_only:
        parser.error("Cannot pass both --fetch-only and --sanitize-only")

    if not args.sanitize_only:
        fetch_all()
    if not args.fetch_only:
        sanitize_all()


if __name__ == "__main__":
    main()
