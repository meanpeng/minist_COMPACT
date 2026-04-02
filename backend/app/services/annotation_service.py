from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from ..config import settings
from ..database import get_connection
from ..errors import NotFoundError, ValidationError
from ..schemas import (
    AnnotationSamplePayload,
    AnnotationSubmitResponse,
    TeamAnnotationStatsResponse,
)
from .auth_service import get_authenticated_user
from .competition_service import get_competition_settings


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


def _decode_image(image_base64: str) -> bytes:
    try:
        payload = image_base64.split(",", 1)[1] if "," in image_base64 else image_base64
        return base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValidationError("Annotation image is not valid base64 PNG data.") from exc


def _relative_image_path(team_id: str, label: int, sample_id: str) -> Path:
    return Path(team_id) / str(label) / f"{sample_id}.png"


def _build_stats(team_id: str, competition_id: str) -> TeamAnnotationStatsResponse:
    competition = get_competition_settings(competition_id)
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT label, COUNT(*) AS sample_count
            FROM annotations
            WHERE team_id = ?
            GROUP BY label
            ORDER BY label ASC
            """,
            (team_id,),
        ).fetchall()

    counts_by_label = [0] * 10
    for row in rows:
        counts_by_label[row["label"]] = row["sample_count"]

    total_count = sum(counts_by_label)
    goal = competition.annotation_goal
    remaining_to_goal = max(goal - total_count, 0)
    progress_ratio = min(total_count / goal, 1.0) if goal > 0 else 1.0

    return TeamAnnotationStatsResponse(
        team_id=team_id,
        total_count=total_count,
        goal=goal,
        remaining_to_goal=remaining_to_goal,
        progress_ratio=progress_ratio,
        counts_by_label=counts_by_label,
    )


def submit_annotation(
    *,
    session_token: str,
    label: int,
    image_base64: str,
) -> AnnotationSubmitResponse:
    auth = get_authenticated_user(session_token)
    user_id = auth["user_id"]
    team_id = auth["team_id"]
    competition_id = auth["competition_id"]
    _ensure_team_membership(user_id, team_id)
    image_bytes = _decode_image(image_base64)
    if not image_bytes:
        raise ValidationError("Annotation image cannot be empty.")

    sample_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    relative_path = _relative_image_path(team_id, label, sample_id)
    absolute_path = settings.annotation_storage_path / relative_path
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_bytes(image_bytes)

    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO annotations (id, user_id, team_id, competition_id, label, image_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (sample_id, user_id, team_id, competition_id, label, relative_path.as_posix(), created_at),
        )
        connection.commit()

    return AnnotationSubmitResponse(
        status="ok",
        sample=AnnotationSamplePayload(
            id=sample_id,
            label=label,
            created_at=created_at,
            image_path=relative_path.as_posix(),
        ),
        stats=_build_stats(team_id, competition_id),
    )


def get_team_annotation_stats(session_token: str) -> TeamAnnotationStatsResponse:
    auth = get_authenticated_user(session_token)
    team_id = auth["team_id"]
    competition_id = auth["competition_id"]

    with get_connection() as connection:
        team = connection.execute(
            """
            SELECT 1
            FROM teams
            WHERE id = ?
            """,
            (team_id,),
        ).fetchone()
        if not team:
            raise NotFoundError("Team was not found.")

    return _build_stats(team_id, competition_id)
