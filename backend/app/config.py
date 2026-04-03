from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple


@dataclass(frozen=True)
class Settings:
    app_name: str
    database_path: Path
    annotation_storage_path: Path
    mnist_storage_path: Path
    cors_origins: Tuple[str, ...]
    admin_ui_base_url: str
    admin_token: str | None
    team_annotation_goal: int
    team_member_limit: int
    session_duration_hours: int
    submission_challenge_ttl_minutes: int
    submission_cooldown_minutes: int
    submission_team_max_attempts: int


def load_settings() -> Settings:
    base_dir = Path(__file__).resolve().parents[1]
    database_path = Path(os.getenv("DATABASE_PATH", base_dir / "data" / "app.db")).resolve()
    annotation_storage_path = Path(
        os.getenv("ANNOTATION_STORAGE_PATH", base_dir / "data" / "annotations")
    ).resolve()
    mnist_storage_path = Path(
        os.getenv("MNIST_STORAGE_PATH", base_dir / "data" / "mnist")
    ).resolve()
    raw_origins = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    cors_origins = tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())
    return Settings(
        app_name=os.getenv("APP_NAME", "mnist-compact-api"),
        database_path=database_path,
        annotation_storage_path=annotation_storage_path,
        mnist_storage_path=mnist_storage_path,
        cors_origins=cors_origins,
        admin_ui_base_url=os.getenv("ADMIN_UI_BASE_URL", "http://localhost:5173"),
        admin_token=os.getenv("ADMIN_TOKEN"),
        team_annotation_goal=int(os.getenv("TEAM_ANNOTATION_GOAL", "50")),
        team_member_limit=int(os.getenv("TEAM_MEMBER_LIMIT", "5")),
        session_duration_hours=int(os.getenv("SESSION_DURATION_HOURS", "24")),
        submission_challenge_ttl_minutes=int(
            os.getenv("SUBMISSION_CHALLENGE_TTL_MINUTES", "10")
        ),
        submission_cooldown_minutes=int(os.getenv("SUBMISSION_COOLDOWN_MINUTES", "5")),
        submission_team_max_attempts=int(os.getenv("SUBMISSION_TEAM_MAX_ATTEMPTS", "10")),
    )


settings = load_settings()
