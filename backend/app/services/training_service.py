from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ..config import settings
from ..database import get_connection
from ..errors import NotFoundError, ValidationError
from ..schemas import (
    TrainingBootstrapResponse,
    TrainingRunMetricPoint,
    TrainingRunPayload,
    TrainingRunResponse,
    TrainingSamplePayload,
)
from .auth_service import get_authenticated_user
from .modeling_service import get_model_config


def _ensure_team_membership(user_id: str, team_id: str) -> None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT 1
            FROM users
            WHERE id = ? AND team_id = ?
            """,
            (user_id, team_id),
        ).fetchone()
        if not row:
            raise NotFoundError("User was not found in the requested team.")


def _build_image_url(relative_path: str) -> str:
    normalized = Path(relative_path).as_posix()
    return f"/api/assets/annotations/{normalized}"


def _serialize_run(row) -> Optional[TrainingRunResponse]:
    if not row:
        return None

    raw_logs = json.loads(row["logs_json"]) if row["logs_json"] else []
    raw_augmentations = json.loads(row["augmentation_modes_json"]) if row["augmentation_modes_json"] else []
    return TrainingRunResponse(
        user_id=row["user_id"],
        team_id=row["team_id"],
        competition_id=row["competition_id"],
        batch_size=row["batch_size"],
        epochs=row["epochs"],
        learning_rate=row["learning_rate"],
        trained_sample_count=row["trained_sample_count"],
        augmentation_modes=raw_augmentations,
        augment_copies=row["augment_copies"] or 1,
        backend=row["backend"],
        final_loss=row["final_loss"],
        final_accuracy=row["final_accuracy"],
        final_val_loss=row["final_val_loss"],
        final_val_accuracy=row["final_val_accuracy"],
        logs=[TrainingRunMetricPoint(**item) for item in raw_logs],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def get_training_bootstrap(session_token: str) -> TrainingBootstrapResponse:
    model_config = get_model_config(session_token)
    user_id = model_config.user_id

    with get_connection() as connection:
        sample_rows = connection.execute(
            """
            SELECT id, label, created_at, image_path
            FROM annotations
            WHERE team_id = ?
            ORDER BY created_at ASC
            """,
            (model_config.team_id,),
        ).fetchall()
        latest_run_row = connection.execute(
            """
            SELECT *
            FROM user_training_runs
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    samples = []
    for row in sample_rows:
        absolute_path = settings.annotation_storage_path / Path(row["image_path"])
        if not absolute_path.exists():
            continue

        samples.append(
            TrainingSamplePayload(
                id=row["id"],
                label=row["label"],
                created_at=row["created_at"],
                image_url=_build_image_url(row["image_path"]),
            )
        )

    return TrainingBootstrapResponse(
        user_id=model_config.user_id,
        team_id=model_config.team_id,
        competition_id=model_config.competition_id,
        samples=samples,
        modeling_config=model_config,
        latest_run=_serialize_run(latest_run_row),
    )


def save_training_run(session_token: str, payload: TrainingRunPayload) -> TrainingRunResponse:
    auth = get_authenticated_user(session_token)
    user_id = auth["user_id"]
    team_id = auth["team_id"]
    competition_id = auth["competition_id"]
    _ensure_team_membership(user_id, team_id)

    if payload.backend.strip().lower() != "cpu":
        raise ValidationError("Training backend must be cpu.")

    if not payload.logs:
        raise ValidationError("Training logs cannot be empty.")

    supported_augmentations = {"rotation", "shift", "scale", "affine"}
    invalid_augmentations = [mode for mode in payload.augmentation_modes if mode not in supported_augmentations]
    if invalid_augmentations:
        raise ValidationError(f"Unsupported augmentation mode(s): {', '.join(invalid_augmentations)}.")

    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as connection:
        count_row = connection.execute(
            """
            SELECT COUNT(*) AS sample_count
            FROM annotations
            WHERE team_id = ?
            """,
            (team_id,),
        ).fetchone()
        available_sample_count = count_row["sample_count"] if count_row else 0

        if payload.trained_sample_count > available_sample_count:
            raise ValidationError("Trained sample count cannot exceed the current team dataset size.")

        existing_row = connection.execute(
            """
            SELECT created_at
            FROM user_training_runs
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

        created_at = existing_row["created_at"] if existing_row else now
        logs_json = json.dumps(
            [
                point.model_dump() if hasattr(point, "model_dump") else point.dict()
                for point in payload.logs
            ]
        )
        augmentation_modes_json = json.dumps(payload.augmentation_modes)

        connection.execute(
            """
            INSERT INTO user_training_runs (
                user_id,
                team_id,
                competition_id,
                batch_size,
                epochs,
                learning_rate,
                trained_sample_count,
                augmentation_modes_json,
                augment_copies,
                final_loss,
                final_accuracy,
                final_val_loss,
                final_val_accuracy,
                logs_json,
                backend,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                team_id = excluded.team_id,
                competition_id = excluded.competition_id,
                batch_size = excluded.batch_size,
                epochs = excluded.epochs,
                learning_rate = excluded.learning_rate,
                trained_sample_count = excluded.trained_sample_count,
                augmentation_modes_json = excluded.augmentation_modes_json,
                augment_copies = excluded.augment_copies,
                final_loss = excluded.final_loss,
                final_accuracy = excluded.final_accuracy,
                final_val_loss = excluded.final_val_loss,
                final_val_accuracy = excluded.final_val_accuracy,
                logs_json = excluded.logs_json,
                backend = excluded.backend,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                team_id,
                competition_id,
                payload.batch_size,
                payload.epochs,
                payload.learning_rate,
                payload.trained_sample_count,
                augmentation_modes_json,
                payload.augment_copies,
                payload.final_loss,
                payload.final_accuracy,
                payload.final_val_loss,
                payload.final_val_accuracy,
                logs_json,
                payload.backend.strip().lower(),
                created_at,
                now,
            ),
        )
        connection.commit()

        stored_row = connection.execute(
            """
            SELECT *
            FROM user_training_runs
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    return _serialize_run(stored_row)
