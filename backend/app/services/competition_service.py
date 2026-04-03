from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from ..config import settings
from ..database import get_connection
from ..errors import NotFoundError, ValidationError
from ..schemas import AdminCompetitionListItemPayload, CompetitionPayload, CompetitionStatusPayload

VALID_MANUAL_STATUSES = {"not_started", "running", "ended"}


def _parse_iso_datetime(value: Optional[str], field_name: str) -> Optional[datetime]:
    if value is None or not str(value).strip():
        return None

    try:
        parsed = datetime.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ValidationError(f"{field_name} must be a valid ISO datetime string.") from exc

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _status_from_end_time(now: datetime, end_time: Optional[datetime]) -> str:
    if end_time and now >= end_time:
        return "ended"
    return "running"


def build_competition_payload(row, now: Optional[datetime] = None) -> CompetitionStatusPayload:
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    end_time = _parse_iso_datetime(row["end_time"], "end_time")
    manual_status = row["manual_status"]
    effective_status = manual_status if manual_status in VALID_MANUAL_STATUSES else _status_from_end_time(current_time, end_time)

    seconds_until_end = None
    if effective_status == "running" and end_time:
        seconds_until_end = max(int((end_time - current_time).total_seconds()), 0)

    allow_submission = bool(row["allow_submission"])
    is_submission_open = allow_submission and effective_status == "running"

    return CompetitionStatusPayload(
        competition_id=row["competition_id"],
        competition_name=row["competition_name"],
        effective_status=effective_status,
        manual_status=manual_status,
        start_time=row["start_time"],
        end_time=row["end_time"],
        current_time=current_time.isoformat(),
        seconds_until_start=None,
        seconds_until_end=seconds_until_end,
        annotation_goal=row["annotation_goal"],
        team_member_limit=row["team_member_limit"],
        submission_limit=row["submission_limit"],
        submission_cooldown_minutes=row["submission_cooldown_minutes"],
        allow_submission=allow_submission,
        is_submission_open=is_submission_open,
    )


def _validate_single_running_competition(
    connection,
    target_competition_id: str,
    *,
    next_manual_status: Optional[str],
    next_end_time: Optional[datetime],
) -> None:
    candidate_row = {
        "competition_id": target_competition_id,
        "competition_name": "",
        "start_time": None,
        "end_time": next_end_time.isoformat() if next_end_time else None,
        "manual_status": next_manual_status,
        "annotation_goal": 0,
        "team_member_limit": settings.team_member_limit,
        "submission_limit": 1,
        "submission_cooldown_minutes": 0,
        "allow_submission": 1,
    }
    if build_competition_payload(candidate_row).effective_status != "running":
        return

    rows = connection.execute(
        """
        SELECT *
        FROM competition_settings
        WHERE competition_id <> ?
        """,
        (target_competition_id,),
    ).fetchall()
    for row in rows:
        if build_competition_payload(row).effective_status == "running":
            raise ValidationError("Another competition is already running. Please end it before starting a new one.")


def list_competitions_for_admin() -> list[CompetitionPayload]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, name, created_at
            FROM competitions
            ORDER BY created_at DESC
            """
        ).fetchall()
    return [CompetitionPayload(id=row["id"], name=row["name"], created_at=row["created_at"]) for row in rows]


def list_competition_statuses_for_admin(selected_competition_id: Optional[str] = None) -> list[AdminCompetitionListItemPayload]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                c.id,
                c.name,
                c.created_at,
                cs.competition_id,
                cs.competition_name,
                cs.start_time,
                cs.end_time,
                cs.manual_status,
                cs.annotation_goal,
                cs.team_member_limit,
                cs.submission_limit,
                cs.submission_cooldown_minutes,
                cs.allow_submission,
                cs.created_at AS settings_created_at,
                cs.updated_at
            FROM competitions c
            JOIN competition_settings cs ON cs.competition_id = c.id
            ORDER BY c.created_at DESC
            """
        ).fetchall()

    return [
        AdminCompetitionListItemPayload(
            id=row["id"],
            name=row["name"],
            created_at=row["created_at"],
            effective_status=build_competition_payload(row).effective_status,
            start_time=row["start_time"],
            end_time=row["end_time"],
            is_selected=row["id"] == selected_competition_id,
        )
        for row in rows
    ]


def create_competition(competition_name: str) -> CompetitionPayload:
    normalized_name = " ".join(competition_name.strip().split())
    if not normalized_name:
        raise ValidationError("Competition name cannot be empty.")

    competition_id = str(uuid4())
    now = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        existing = connection.execute(
            """
            SELECT id
            FROM competitions
            WHERE lower(name) = lower(?)
            """,
            (normalized_name,),
        ).fetchone()
        if existing:
            raise ValidationError("Competition name already exists.")

        connection.execute(
            """
            INSERT INTO competitions (id, name, created_at)
            VALUES (?, ?, ?)
            """,
            (competition_id, normalized_name, now),
        )
        connection.execute(
            """
            INSERT INTO competition_settings (
                competition_id,
                competition_name,
                start_time,
                end_time,
                manual_status,
                annotation_goal,
                team_member_limit,
                submission_limit,
                submission_cooldown_minutes,
                allow_submission,
                created_at,
                updated_at
            )
            VALUES (?, ?, NULL, NULL, NULL, 50, ?, 10, 5, 1, ?, ?)
            """,
            (competition_id, normalized_name, settings.team_member_limit, now, now),
        )
        connection.commit()

    return CompetitionPayload(id=competition_id, name=normalized_name, created_at=now)


def get_competition_settings(competition_id: str) -> CompetitionStatusPayload:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT *
            FROM competition_settings
            WHERE competition_id = ?
            """,
            (competition_id,),
        ).fetchone()
        if not row:
            raise NotFoundError("Competition settings were not found.")
        return build_competition_payload(row)


def update_competition_settings(
    *,
    competition_id: str,
    competition_name: str,
    end_time: Optional[str],
    manual_status: Optional[str],
    annotation_goal: int,
    team_member_limit: int,
    submission_limit: int,
    submission_cooldown_minutes: int,
    allow_submission: bool,
) -> CompetitionStatusPayload:
    normalized_name = " ".join(competition_name.strip().split())
    if not normalized_name:
        raise ValidationError("Competition name cannot be empty.")

    normalized_manual_status = manual_status or None
    if normalized_manual_status and normalized_manual_status not in VALID_MANUAL_STATUSES:
        raise ValidationError("Manual status must be one of: not_started, running, ended.")

    parsed_end = _parse_iso_datetime(end_time, "end_time")

    updated_at = datetime.now(timezone.utc).isoformat()

    with get_connection() as connection:
        existing = connection.execute(
            """
            SELECT id
            FROM competitions
            WHERE id = ?
            """,
            (competition_id,),
        ).fetchone()
        if not existing:
            raise NotFoundError("Competition was not found.")

        duplicate = connection.execute(
            """
            SELECT id
            FROM competitions
            WHERE lower(name) = lower(?) AND id <> ?
            """,
            (normalized_name, competition_id),
        ).fetchone()
        if duplicate:
            raise ValidationError("Competition name already exists.")

        _validate_single_running_competition(
            connection,
            competition_id,
            next_manual_status=normalized_manual_status,
            next_end_time=parsed_end,
        )

        connection.execute(
            """
            UPDATE competitions
            SET name = ?
            WHERE id = ?
            """,
            (normalized_name, competition_id),
        )
        connection.execute(
            """
            UPDATE competition_settings
            SET competition_name = ?,
                end_time = ?,
                manual_status = ?,
                annotation_goal = ?,
                team_member_limit = ?,
                submission_limit = ?,
                submission_cooldown_minutes = ?,
                allow_submission = ?,
                updated_at = ?
            WHERE competition_id = ?
            """,
            (
                normalized_name,
                parsed_end.isoformat() if parsed_end else None,
                normalized_manual_status,
                annotation_goal,
                team_member_limit,
                submission_limit,
                submission_cooldown_minutes,
                1 if allow_submission else 0,
                updated_at,
                competition_id,
            ),
        )
        connection.commit()

    return get_competition_settings(competition_id)


def set_manual_competition_status(competition_id: str, manual_status: Optional[str]) -> CompetitionStatusPayload:
    if manual_status is not None and manual_status not in VALID_MANUAL_STATUSES:
        raise ValidationError("Manual status must be one of: not_started, running, ended.")

    with get_connection() as connection:
        if manual_status == "running":
            current_row = connection.execute(
                """
                SELECT *
                FROM competition_settings
                WHERE competition_id = ?
                """,
                (competition_id,),
            ).fetchone()
            if not current_row:
                raise NotFoundError("Competition settings were not found.")
            if build_competition_payload(current_row).effective_status == "ended":
                raise ValidationError("Ended competitions are kept as snapshots and cannot be started again.")
            _validate_single_running_competition(
                connection,
                competition_id,
                next_manual_status=manual_status,
                next_end_time=_parse_iso_datetime(current_row["end_time"], "end_time"),
            )

        updated = connection.execute(
            """
            UPDATE competition_settings
            SET manual_status = ?, updated_at = ?
            WHERE competition_id = ?
            """,
            (
                manual_status,
                datetime.now(timezone.utc).isoformat(),
                competition_id,
            ),
        ).rowcount
        if updated != 1:
            raise NotFoundError("Competition settings were not found.")
        connection.commit()

    return get_competition_settings(competition_id)


def ensure_submissions_open(competition_id: str) -> CompetitionStatusPayload:
    competition = get_competition_settings(competition_id)
    if not competition.allow_submission:
        raise ValidationError("Teacher has disabled score submissions for this competition.")
    if competition.effective_status == "not_started":
        raise ValidationError("Competition has not started yet, so score submissions are locked.")
    if competition.effective_status == "ended":
        raise ValidationError("Competition has ended, and the leaderboard is now fixed.")
    return competition


def list_running_competitions() -> list[CompetitionPayload]:
    competitions = []
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                c.id,
                c.name,
                c.created_at,
                cs.competition_id,
                cs.competition_name,
                cs.start_time,
                cs.end_time,
                cs.manual_status,
                cs.annotation_goal,
                cs.team_member_limit,
                cs.submission_limit,
                cs.submission_cooldown_minutes,
                cs.allow_submission,
                cs.created_at AS settings_created_at,
                cs.updated_at
            FROM competitions c
            JOIN competition_settings cs ON cs.competition_id = c.id
            ORDER BY c.created_at DESC
            """
        ).fetchall()

    for row in rows:
        if build_competition_payload(row).effective_status == "running":
            competitions.append(CompetitionPayload(id=row["id"], name=row["name"], created_at=row["created_at"]))

    return competitions[:1]
