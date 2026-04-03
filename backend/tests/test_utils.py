from __future__ import annotations

import importlib
from contextlib import ExitStack, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

MODULE_NAMES = [
    "backend.app.config",
    "backend.app.database",
    "backend.app.main",
    "backend.app.services.admin_service",
    "backend.app.services.annotation_service",
    "backend.app.services.auth_service",
    "backend.app.services.competition_service",
    "backend.app.services.submission_service",
    "backend.app.services.training_service",
]


def make_test_settings(root: Path, **overrides) -> SimpleNamespace:
    defaults = {
        "app_name": "mnist-compact-api-test",
        "database_path": root / "app.db",
        "annotation_storage_path": root / "annotations",
        "mnist_storage_path": root / "mnist",
        "cors_origins": ("http://localhost:5173",),
        "admin_ui_base_url": "http://localhost:5173",
        "admin_token": "admin-token",
        "team_annotation_goal": 3,
        "team_member_limit": 2,
        "session_duration_hours": 24,
        "submission_challenge_ttl_minutes": 10,
        "submission_cooldown_minutes": 0,
        "submission_team_max_attempts": 1,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@contextmanager
def patched_backend_environment(**overrides):
    with TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        settings = make_test_settings(root, **overrides)
        with ExitStack() as stack:
            for module_name in MODULE_NAMES:
                module = importlib.import_module(module_name)
                stack.enter_context(patch.object(module, "settings", settings))
            from backend.app.database import init_db

            init_db()
            yield settings
