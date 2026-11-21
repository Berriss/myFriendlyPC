#!/usr/bin/env python3
"""
Fetch today's official USD -> CLP exchange rate into resources/exchange_rate.json.

Sources:
  1. https://mindicador.cl/api/dolar (Banco Central de Chile - Dólar Observado)
  2. https://open.er-api.com/v6/latest/USD (Fallback)
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT_DIR / "resources" / "exchange_rate.json"
USER_AGENT = "HololiveOCGTracker/1.0 (+local-collection-app)"


def fetch_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_clp_rate() -> dict:
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        data = fetch_json("https://mindicador.cl/api/dolar")
        serie = data.get("serie") or []
        if serie and isinstance(serie[0].get("valor"), (int, float)):
            rate = float(serie[0]["valor"])
            observed = str(serie[0].get("fecha") or now_iso)[:10]
            return {
                "rateClpPerUsd": round(rate, 2),
                "source": "Banco Central de Chile (mindicador.cl)",
                "observedDate": observed,
                "updatedAt": now_iso,
            }
    except Exception as exc:
        print(f"mindicador.cl unavailable ({exc}), trying fallback...", file=sys.stderr)

    data = fetch_json("https://open.er-api.com/v6/latest/USD")
    rates = data.get("rates") or {}
    if "CLP" not in rates:
        raise RuntimeError("Fallback API did not return CLP rate")
    rate = float(rates["CLP"])
    observed = str(data.get("time_last_update_utc") or now_iso)[:16]
    return {
        "rateClpPerUsd": round(rate, 2),
        "source": "open.er-api.com (USD/CLP)",
        "observedDate": observed,
        "updatedAt": now_iso,
    }


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = get_clp_rate()
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
