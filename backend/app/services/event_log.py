from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from ..config import settings

_LOG_LOCK = Lock()


def _safe_file_stem(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return normalized or "unknown-competition"


def append_competition_event(
    *,
    competition_id: str,
    event_type: str,
    user_id: str | None = None,
    username: str | None = None,
    team_id: str | None = None,
    team_name: str | None = None,
    details: dict[str, Any] | None = None,
    created_at: str | None = None,
) -> None:
    log_dir = settings.database_path.parent / "competition_logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{_safe_file_stem(competition_id)}.log"
    event = {
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
        "competition_id": competition_id,
        "event_type": event_type,
        "user_id": user_id,
        "username": username,
        "team_id": team_id,
        "team_name": team_name,
        "details": details or {},
    }
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    with _LOG_LOCK:
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
