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
    local_test_storage_path: Path
    frontend_dist_path: Path
    cors_origins: Tuple[str, ...]
    admin_ui_base_url: str
    admin_token: str | None
    team_annotation_goal: int
    team_member_limit: int
    session_duration_hours: int
    submission_challenge_ttl_minutes: int
    submission_cooldown_minutes: int
    submission_team_max_attempts: int
    default_test_dataset_source: str
    redis_url: str | None


def _load_test_dataset_source(value: str | None) -> str:
    normalized = (value or "local_test").strip()
    if normalized not in {"mnist", "local_test"}:
        raise ValueError("DEFAULT_TEST_DATASET_SOURCE must be one of: mnist, local_test.")
    return normalized


def load_settings() -> Settings:
    base_dir = Path(__file__).resolve().parents[1]
    project_root = base_dir.parent
    database_path = Path(os.getenv("DATABASE_PATH", base_dir / "data" / "app.db")).resolve()
    annotation_storage_path = Path(
        os.getenv("ANNOTATION_STORAGE_PATH", base_dir / "data" / "annotations")
    ).resolve()
    mnist_storage_path = Path(
        os.getenv("MNIST_STORAGE_PATH", base_dir / "data" / "mnist")
    ).resolve()
    local_test_storage_path = Path(
        os.getenv("TEST_DATASET_PATH", base_dir / "data" / "test")
    ).resolve()
    frontend_dist_path = Path(os.getenv("FRONTEND_DIST_PATH", project_root / "dist")).resolve()
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
        local_test_storage_path=local_test_storage_path,
        frontend_dist_path=frontend_dist_path,
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
        default_test_dataset_source=_load_test_dataset_source(os.getenv("DEFAULT_TEST_DATASET_SOURCE")),
        redis_url=os.getenv("REDIS_URL") or None,
    )


settings = load_settings()
