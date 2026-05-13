from __future__ import annotations

import base64
import gzip
import json
import random
import struct
import urllib.request
import zlib
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
from .competition_service import ensure_submissions_open, _normalize_test_dataset_source
from .event_log import append_competition_event
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
    source: str


_DATASET_CACHE: dict[str, MnistTestDataset] = {}


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


def _apply_png_filter(filter_type: int, scanline: bytearray, previous: bytes, bytes_per_pixel: int) -> bytes:
    if filter_type == 0:
        return bytes(scanline)

    for index, value in enumerate(scanline):
        left = scanline[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
        up = previous[index] if previous else 0
        up_left = previous[index - bytes_per_pixel] if previous and index >= bytes_per_pixel else 0

        if filter_type == 1:
            scanline[index] = (value + left) & 0xFF
        elif filter_type == 2:
            scanline[index] = (value + up) & 0xFF
        elif filter_type == 3:
            scanline[index] = (value + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            predictor = left + up - up_left
            pa = abs(predictor - left)
            pb = abs(predictor - up)
            pc = abs(predictor - up_left)
            if pa <= pb and pa <= pc:
                paeth = left
            elif pb <= pc:
                paeth = up
            else:
                paeth = up_left
            scanline[index] = (value + paeth) & 0xFF
        else:
            raise ValidationError("Local test PNG uses an unsupported filter.")

    return bytes(scanline)


def _unpack_png_1bit_grayscale(row: bytes, width: int) -> list[int]:
    pixels: list[int] = []
    for byte in row:
        for shift in range(7, -1, -1):
            pixels.append(255 if ((byte >> shift) & 1) else 0)
            if len(pixels) == width:
                return pixels
    return pixels


def _decode_png_to_grayscale_pixels(image_bytes: bytes) -> tuple[int, int, bytes]:
    if not image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValidationError("Local test dataset images must be PNG files.")

    offset = 8
    width = height = bit_depth = color_type = None
    compressed_parts: list[bytes] = []

    while offset + 8 <= len(image_bytes):
        chunk_length = struct.unpack(">I", image_bytes[offset : offset + 4])[0]
        chunk_type = image_bytes[offset + 4 : offset + 8]
        chunk_data_start = offset + 8
        chunk_data_end = chunk_data_start + chunk_length
        chunk_data = image_bytes[chunk_data_start:chunk_data_end]
        offset = chunk_data_end + 4

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            if compression != 0 or filter_method != 0 or interlace != 0:
                raise ValidationError("Local test PNG must use standard non-interlaced encoding.")
        elif chunk_type == b"IDAT":
            compressed_parts.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width is None or height is None or bit_depth is None or color_type is None:
        raise ValidationError("Local test PNG is missing image metadata.")
    if width <= 0 or height <= 0:
        raise ValidationError("Local test PNG dimensions are invalid.")
    if color_type not in {0, 2, 4, 6}:
        raise ValidationError("Local test PNG color type is unsupported.")
    if bit_depth not in {1, 8}:
        raise ValidationError("Local test PNG bit depth must be 1 or 8.")
    if bit_depth == 1 and color_type != 0:
        raise ValidationError("1-bit local test PNGs must be grayscale.")

    channels_by_color_type = {0: 1, 2: 3, 4: 2, 6: 4}
    channels = channels_by_color_type[color_type]
    bytes_per_pixel = max(1, channels * bit_depth // 8)
    row_data_bytes = ((width * channels * bit_depth) + 7) // 8
    decompressed = zlib.decompress(b"".join(compressed_parts))
    expected_size = (row_data_bytes + 1) * height
    if len(decompressed) < expected_size:
        raise ValidationError("Local test PNG pixel data is truncated.")

    grayscale: list[int] = []
    previous = b"\x00" * row_data_bytes
    cursor = 0
    for _ in range(height):
        filter_type = decompressed[cursor]
        cursor += 1
        raw_scanline = bytearray(decompressed[cursor : cursor + row_data_bytes])
        cursor += row_data_bytes
        scanline = _apply_png_filter(filter_type, raw_scanline, previous, bytes_per_pixel)
        previous = scanline

        if bit_depth == 1:
            grayscale.extend(_unpack_png_1bit_grayscale(scanline, width))
            continue

        for pixel_start in range(0, width * channels, channels):
            if color_type in {0, 4}:
                grayscale.append(scanline[pixel_start])
            else:
                red = scanline[pixel_start]
                green = scanline[pixel_start + 1]
                blue = scanline[pixel_start + 2]
                grayscale.append(round((0.299 * red) + (0.587 * green) + (0.114 * blue)))

    return width, height, bytes(grayscale)


def _resize_grayscale_nearest(pixels: bytes, width: int, height: int, target_size: int = 28) -> bytes:
    if width == target_size and height == target_size:
        return pixels

    resized = bytearray(target_size * target_size)
    for target_y in range(target_size):
        source_y = min((target_y * height) // target_size, height - 1)
        for target_x in range(target_size):
            source_x = min((target_x * width) // target_size, width - 1)
            resized[target_y * target_size + target_x] = pixels[source_y * width + source_x]
    return bytes(resized)


def _load_local_png_as_mnist_pixels(image_path: Path) -> bytes:
    width, height, pixels = _decode_png_to_grayscale_pixels(image_path.read_bytes())
    return _resize_grayscale_nearest(pixels, width, height)


def _load_mnist_dataset() -> MnistTestDataset:
    images_path = _download_if_missing(MNIST_FILES["images"])
    labels_path = _download_if_missing(MNIST_FILES["labels"])
    images = _load_idx_images(images_path)
    labels = _load_idx_labels(labels_path)
    if len(images) != len(labels):
        raise ValidationError("MNIST test set images and labels are misaligned.")

    return MnistTestDataset(images=images, labels=labels, source="mnist")


def _load_local_test_dataset() -> MnistTestDataset:
    root_path = settings.local_test_storage_path
    if not root_path.exists():
        raise ValidationError("Local test dataset path does not exist.")

    images: list[bytes] = []
    labels: list[int] = []
    label_directories = sorted(
        (path for path in root_path.iterdir() if path.is_dir() and path.name.isdigit()),
        key=lambda path: int(path.name),
    )
    for label_directory in label_directories:
        label = int(label_directory.name)
        if label < 0 or label > 9:
            raise ValidationError("Local test dataset labels must be directories 0 through 9.")
        for image_path in sorted(label_directory.glob("*.png")):
            images.append(_load_local_png_as_mnist_pixels(image_path))
            labels.append(label)

    if not images:
        raise ValidationError("Local test dataset is empty.")

    return MnistTestDataset(images=tuple(images), labels=tuple(labels), source="local_test")


def _get_dataset(test_dataset_source: str = "mnist") -> MnistTestDataset:
    normalized_source = _normalize_test_dataset_source(test_dataset_source)

    if normalized_source not in _DATASET_CACHE:
        if normalized_source == "mnist":
            _DATASET_CACHE[normalized_source] = _load_mnist_dataset()
        else:
            _DATASET_CACHE[normalized_source] = _load_local_test_dataset()

    return _DATASET_CACHE[normalized_source]


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
            dataset = _get_dataset(competition.test_dataset_source)
            challenge_sample_count = min(SUBMISSION_SAMPLE_COUNT, len(dataset.labels))
            if challenge_sample_count <= 0:
                raise ValidationError("Test dataset is empty.")
            sample_indexes = random.sample(range(len(dataset.labels)), challenge_sample_count)
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
                    test_dataset_source,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission_id,
                    model_config.user_id,
                    model_config.team_id,
                    model_config.competition_id,
                    json.dumps(sample_indexes),
                    None,
                    expires_at,
                    competition.test_dataset_source,
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
        dataset = _get_dataset(competition.test_dataset_source)
        challenge_images = [
            SubmissionChallengeImagePayload(
                index=challenge_index,
                pixels_b64=base64.b64encode(dataset.images[sample_index]).decode("ascii"),
            )
            for challenge_index, sample_index in enumerate(sample_indexes)
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
            SELECT sample_indexes_json, used_at, expires_at, test_dataset_source
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
        dataset_source = _normalize_test_dataset_source(challenge_row["test_dataset_source"] if "test_dataset_source" in challenge_row.keys() else competition.test_dataset_source)
        dataset = _get_dataset(dataset_source)
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

    append_competition_event(
        competition_id=competition_id,
        event_type="submission_evaluated",
        user_id=user_id,
        username=auth["username"],
        team_id=team_id,
        team_name=auth["team_name"],
        details={
            "result_id": result_id,
            "submission_id": submission_id,
            "accuracy": accuracy,
            "correct_count": correct_count,
            "sample_count": sample_count,
            "param_count": param_count,
            "rank": rank,
            "remaining_team_attempts": remaining_team_attempts,
            "test_dataset_source": dataset_source,
        },
        created_at=now,
    )
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
