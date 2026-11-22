#!/usr/bin/env python3
"""Shared Firebase Admin SDK initialization helper for Firestore sync scripts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

DEFAULT_PROJECT_ID = "hololive-ocg-tracker-sb"


def init_firestore_client(
    service_account: str | None = None,
    project_id: str | None = None,
) -> tuple[Any, str]:
    """Initialize firebase_admin once and return (firestore_client, project_id)."""
    import firebase_admin
    from firebase_admin import credentials, firestore

    resolved_project = (
        (project_id or "").strip()
        or os.environ.get("FIREBASE_PROJECT_ID", "").strip()
        or DEFAULT_PROJECT_ID
    )

    if not firebase_admin._apps:
        cred = _load_credentials(credentials, service_account)
        firebase_admin.initialize_app(cred, {"projectId": resolved_project})

    return firestore.client(), resolved_project


def _load_credentials(credentials_mod: Any, service_account_arg: str | None) -> Any:
    """Resolve Service Account credentials from CLI arg, env JSON/path, or ADC."""
    candidate = (service_account_arg or "").strip() or os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if candidate:
        if candidate.startswith("{"):
            info = json.loads(candidate)
            return credentials_mod.Certificate(info)
        path = Path(candidate).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"Service account file not found: {path}")
        return credentials_mod.Certificate(str(path))

    gac = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if gac:
        path = Path(gac).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"GOOGLE_APPLICATION_CREDENTIALS file not found: {path}")
        return credentials_mod.Certificate(str(path))

    return credentials_mod.ApplicationDefault()
