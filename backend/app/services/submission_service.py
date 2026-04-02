from __future__ import annotations

import base64
import gzip
import json
import random
import struct
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Sequence, Tuple, List
from uuid import uuid4

from ..config import settings
from ..database import get_connection
from ..errors import NotFoundError, ValidationError
from ..schemas import (
    SubmissionBootstrapResponse,
    SubmissionChallengeImagePayload,
    SubmissionEvaluateResponse,
    SubmissionScorePayload,
)
from .auth_service import get_authenticated_user
from .competition_service import ensure_submissions_open
from .modeling_service import get_model_config
from .training_service import _serialize_run

MNIST_FILES = {
    "images": "t10k-images-idx3-ubyte.gz",
    "labels": "t10k-labels-idx1-ubyte.gz",
}
MNIST_BASE_URL = "https://storage.googleapis.com/cvdf-datasets/mnist"
SUBMISSION_SAMPLE_COUNT = 1000


@dataclass(frozen=True)
class MnistTestDataset:
    images: Tuple[bytes, ...]
    labels: Tuple[int, ...]


_DATASET_CACHE: Optional[MnistTestDataset] = None


def _download_if_missing(file_name: str) -> Path:
    target_path = settings.mnist_storage_path / file_name
    if target_path.exists():
        return target_path

    urllib.request.urlretrieve(f"{MNIST_BASE_URL}/{file_name}", target_path)
    return target_path


def _load_idx_images(file_path: Path) -> Tuple[bytes, ...]:
    with gzip.open(file_path, "rb") as handle:
        magic, count, rows, cols = struct.unpack(">IIII", handle.read(16))
        if magic != 2051:
            raise ValidationError("MNIST image file format is invalid.")

        image_size = rows * cols
        raw = handle.read(count * image_size)
        return tuple(raw[index * image_size : (index + 1) * image_size] for index in range(count))


def _load_idx_labels(file_path: Path) -> Tuple[int, ...]:
    with gzip.open(file_path, "rb") as handle:
        magic, count = struct.unpack(">II", handle.read(8))
        if magic != 2049:
            raise ValidationError("MNIST label file format is invalid.")

        return tuple(handle.read(count))


def _get_dataset() -> MnistTestDataset:
    global _DATASET_CACHE

    if _DATASET_CACHE is None:
        images_path = _download_if_missing(MNIST_FILES["images"])
        labels_path = _download_if_missing(MNIST_FILES["labels"])
        images = _load_idx_images(images_path)
        labels = _load_idx_labels(labels_path)
        if len(images) != len(labels):
            raise ValidationError("MNIST test set images and labels are misaligned.")

        _DATASET_CACHE = MnistTestDataset(images=images, labels=labels)

    return _DATASET_CACHE


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


def _serialize_score(row) -> Optional[SubmissionScorePayload]:
    if not row:
        return None

    return SubmissionScorePayload(
        accuracy=row["accuracy"],
        param_count=row["param_count"],
        team_id=row["team_id"],
        team_name=row["team_name"],
        submitted_by=row["submitted_by"],
        created_at=row["created_at"],
    )


def _fetch_leaderboard(connection, competition_id: str) -> List[SubmissionScorePayload]:
    rows = connection.execute(
        """
        WITH ranked_results AS (
            SELECT
                sr.*,
                t.name AS team_name,
                u.username AS submitted_by,
                ROW_NUMBER() OVER (
                    PARTITION BY sr.team_id
                    ORDER BY sr.accuracy DESC, sr.param_count ASC, sr.created_at ASC
                ) AS team_rank
            FROM submission_results sr
            JOIN teams t ON t.id = sr.team_id
            JOIN users u ON u.id = sr.user_id
            WHERE sr.competition_id = ?
        )
        SELECT accuracy, param_count, team_id, team_name, submitted_by, created_at
        FROM ranked_results
        WHERE team_rank = 1
        ORDER BY accuracy DESC, param_count ASC, created_at ASC
        LIMIT 10
        """,
        (competition_id,),
    ).fetchall()
    return [_serialize_score(row) for row in rows if row]


def _fetch_team_rank(connection, competition_id: str, team_id: str) -> Optional[int]:
    row = connection.execute(
        """
        WITH best_results AS (
            SELECT
                sr.team_id,
                sr.accuracy,
                sr.param_count,
                sr.created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY sr.team_id
                    ORDER BY sr.accuracy DESC, sr.param_count ASC, sr.created_at ASC
                ) AS team_rank
            FROM submission_results sr
            WHERE sr.competition_id = ?
        ),
        ranked_teams AS (
            SELECT
                team_id,
                ROW_NUMBER() OVER (
                    ORDER BY accuracy DESC, param_count ASC, created_at ASC
                ) AS overall_rank
            FROM best_results
            WHERE team_rank = 1
        )
        SELECT overall_rank
        FROM ranked_teams
        WHERE team_id = ?
        """,
        (competition_id, team_id),
    ).fetchone()
    return row["overall_rank"] if row else None


def _count_team_submissions(connection, competition_id: str, team_id: str) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS submission_count
        FROM submission_results
        WHERE competition_id = ? AND team_id = ?
        """,
        (competition_id, team_id),
    ).fetchone()
    return row["submission_count"] if row else 0


def _remaining_team_attempts(connection, competition_id: str, team_id: str, submission_limit: int) -> int:
    return max(submission_limit - _count_team_submissions(connection, competition_id, team_id), 0)


def _validate_submission_limits(
    connection,
    competition_id: str,
    user_id: str,
    team_id: str,
    now: datetime,
    *,
    submission_cooldown_minutes: int,
    submission_limit: int,
) -> None:
    cooldown_started_at = (now - timedelta(minutes=submission_cooldown_minutes)).isoformat()
    recent_submission = connection.execute(
        """
        SELECT created_at
        FROM submission_results
        WHERE competition_id = ? AND user_id = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (competition_id, user_id, cooldown_started_at),
    ).fetchone()
    if recent_submission:
        raise ValidationError(
            f"Each user can submit at most once every {submission_cooldown_minutes} minutes."
        )

    team_submission_count = _count_team_submissions(connection, competition_id, team_id)
    if team_submission_count >= submission_limit:
        raise ValidationError(
            f"Your team has reached the submission limit of {submission_limit} attempts."
        )


def _get_submission_limit_error(
    connection,
    competition_id: str,
    user_id: str,
    team_id: str,
    now: datetime,
    *,
    submission_cooldown_minutes: int,
    submission_limit: int,
) -> Optional[str]:
    try:
        _validate_submission_limits(
            connection,
            competition_id,
            user_id,
            team_id,
            now,
            submission_cooldown_minutes=submission_cooldown_minutes,
            submission_limit=submission_limit,
        )
    except ValidationError as error:
        return str(error)

    return None


def create_submission_bootstrap(session_token: str) -> SubmissionBootstrapResponse:
    model_config = get_model_config(session_token)
    _ensure_team_membership(model_config.user_id, model_config.team_id)
    competition = ensure_submissions_open(model_config.competition_id)

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    sample_indexes: List[int] = []
    submission_id: Optional[str] = None

    with get_connection() as connection:
        submission_block_reason = _get_submission_limit_error(
            connection,
            model_config.competition_id,
            model_config.user_id,
            model_config.team_id,
            now_dt,
            submission_cooldown_minutes=competition.submission_cooldown_minutes,
            submission_limit=competition.submission_limit,
        )
        if not submission_block_reason:
            dataset = _get_dataset()
            sample_indexes = random.sample(range(len(dataset.labels)), SUBMISSION_SAMPLE_COUNT)
            expires_at = (now_dt + timedelta(minutes=settings.submission_challenge_ttl_minutes)).isoformat()
            submission_id = str(uuid4())
            connection.execute(
                """
                UPDATE submission_challenges
                SET expires_at = ?
                WHERE competition_id = ? AND user_id = ? AND team_id = ? AND used_at IS NULL AND expires_at > ?
                """,
                (now, model_config.competition_id, model_config.user_id, model_config.team_id, now),
            )
            connection.execute(
                """
                INSERT INTO submission_challenges (
                    id,
                    user_id,
                    team_id,
                    competition_id,
                    sample_indexes_json,
                    used_at,
                    expires_at,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission_id,
                    model_config.user_id,
                    model_config.team_id,
                    model_config.competition_id,
                    json.dumps(sample_indexes),
                    None,
                    expires_at,
                    now,
                ),
            )

        latest_run_row = connection.execute(
            """
            SELECT *
            FROM user_training_runs
            WHERE user_id = ?
            """,
            (model_config.user_id,),
        ).fetchone()
        latest_result_row = connection.execute(
            """
            SELECT
                sr.accuracy,
                sr.param_count,
                sr.team_id,
                t.name AS team_name,
                u.username AS submitted_by,
                sr.created_at
            FROM submission_results sr
            JOIN teams t ON t.id = sr.team_id
            JOIN users u ON u.id = sr.user_id
            WHERE sr.competition_id = ? AND sr.team_id = ?
            ORDER BY sr.accuracy DESC, sr.param_count ASC, sr.created_at ASC
            LIMIT 1
            """,
            (model_config.competition_id, model_config.team_id),
        ).fetchone()
        leaderboard = _fetch_leaderboard(connection, model_config.competition_id)
        remaining_team_attempts = _remaining_team_attempts(
            connection,
            model_config.competition_id,
            model_config.team_id,
            competition.submission_limit,
        )
        connection.commit()

    challenge_images: List[SubmissionChallengeImagePayload] = []
    if sample_indexes:
        dataset = _get_dataset()
        challenge_images = [
            SubmissionChallengeImagePayload(
                index=sample_index,
                pixels_b64=base64.b64encode(dataset.images[sample_index]).decode("ascii"),
            )
            for sample_index in sample_indexes
        ]

    return SubmissionBootstrapResponse(
        submission_id=submission_id,
        user_id=model_config.user_id,
        team_id=model_config.team_id,
        sample_count=len(challenge_images),
        competition=competition,
        team_submission_limit=competition.submission_limit,
        remaining_team_attempts=remaining_team_attempts,
        submission_available=not submission_block_reason,
        submission_block_reason=submission_block_reason,
        challenge_images=challenge_images,
        modeling_config=model_config,
        latest_run=_serialize_run(latest_run_row),
        latest_result=_serialize_score(latest_result_row),
        leaderboard=leaderboard,
    )


def evaluate_submission(
    session_token: str,
    submission_id: str,
    predictions: Sequence[int],
    param_count: int,
) -> SubmissionEvaluateResponse:
    auth = get_authenticated_user(session_token)
    competition = ensure_submissions_open(auth["competition_id"])
    user_id = auth["user_id"]
    team_id = auth["team_id"]
    competition_id = auth["competition_id"]
    _ensure_team_membership(user_id, team_id)
    dataset = _get_dataset()

    with get_connection() as connection:
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        _validate_submission_limits(
            connection,
            competition_id,
            user_id,
            team_id,
            now_dt,
            submission_cooldown_minutes=competition.submission_cooldown_minutes,
            submission_limit=competition.submission_limit,
        )
        challenge_row = connection.execute(
            """
            SELECT sample_indexes_json, used_at, expires_at
            FROM submission_challenges
            WHERE id = ? AND competition_id = ? AND user_id = ? AND team_id = ?
            """,
            (submission_id, competition_id, user_id, team_id),
        ).fetchone()
        if not challenge_row:
            raise NotFoundError("Submission challenge was not found. Refresh the submit page and try again.")
        if challenge_row["used_at"]:
            raise ValidationError("This submission challenge has already been used. Refresh the submit page and try again.")
        if challenge_row["expires_at"] and challenge_row["expires_at"] <= now:
            raise ValidationError("This submission challenge has expired. Refresh the submit page and try again.")

        sample_indexes = json.loads(challenge_row["sample_indexes_json"])
        if len(predictions) != len(sample_indexes):
            raise ValidationError("Prediction count does not match the validation sample count.")

        if any(prediction < 0 or prediction > 9 for prediction in predictions):
            raise ValidationError("Predictions must be integers between 0 and 9.")

        labels = [dataset.labels[index] for index in sample_indexes]
        correct_count = sum(int(prediction == label) for prediction, label in zip(predictions, labels))
        sample_count = len(sample_indexes)
        accuracy = correct_count / sample_count
        result_id = str(uuid4())

        updated_row_count = connection.execute(
            """
            UPDATE submission_challenges
            SET used_at = ?
            WHERE id = ? AND competition_id = ? AND user_id = ? AND team_id = ? AND used_at IS NULL AND expires_at > ?
            """,
            (now, submission_id, competition_id, user_id, team_id, now),
        ).rowcount
        if updated_row_count != 1:
            raise ValidationError("This submission challenge is no longer valid. Refresh the submit page and try again.")

        connection.execute(
            """
            INSERT INTO submission_results (
                id,
                submission_id,
                user_id,
                team_id,
                competition_id,
                accuracy,
                correct_count,
                sample_count,
                param_count,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                result_id,
                submission_id,
                user_id,
                team_id,
                competition_id,
                accuracy,
                correct_count,
                sample_count,
                param_count,
                now,
            ),
        )

        latest_result_row = connection.execute(
            """
            SELECT
                sr.accuracy,
                sr.param_count,
                sr.team_id,
                t.name AS team_name,
                u.username AS submitted_by,
                sr.created_at
            FROM submission_results sr
            JOIN teams t ON t.id = sr.team_id
            JOIN users u ON u.id = sr.user_id
            WHERE sr.id = ?
            """,
            (result_id,),
        ).fetchone()
        leaderboard = _fetch_leaderboard(connection, competition_id)
        rank = _fetch_team_rank(connection, competition_id, team_id) or 1
        remaining_team_attempts = _remaining_team_attempts(
            connection,
            competition_id,
            team_id,
            competition.submission_limit,
        )
        connection.commit()

    return SubmissionEvaluateResponse(
        competition=competition,
        accuracy=accuracy,
        correct_count=correct_count,
        sample_count=sample_count,
        rank=rank,
        team_submission_limit=competition.submission_limit,
        remaining_team_attempts=remaining_team_attempts,
        leaderboard=leaderboard,
        latest_result=_serialize_score(latest_result_row),
    )
