from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Dict, List
from uuid import uuid4

from ..config import settings
from ..database import get_connection
from ..errors import ConflictError, NotFoundError, UnauthorizedError, ValidationError
from ..schemas import CompetitionPayload, CompetitionStatusPayload, SessionResponse, TeamPayload, UserPayload
from .competition_service import get_competition_settings, list_running_competitions


def _normalize_name(value: str, field_name: str) -> str:
    normalized = " ".join(value.strip().split())
    if not normalized:
        raise ValidationError(f"{field_name} cannot be empty.")
    return normalized


def _normalize_invite_code(value: str) -> str:
    normalized = value.strip().upper()
    if not normalized:
        raise ValidationError("Invite code cannot be empty.")
    return normalized


def _build_team_code(team_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", team_name.lower()).strip("-")
    slug = slug[:12] if slug else "team"
    return f"{slug}-{secrets.token_hex(2)}".upper()


def _get_competition_row(connection, competition_id: str):
    row = connection.execute(
        """
        SELECT id, name, created_at
        FROM competitions
        WHERE id = ?
        """,
        (competition_id,),
    ).fetchone()
    if not row:
        raise NotFoundError("Competition was not found.")
    return row


def list_competitions() -> List[CompetitionPayload]:
    return list_running_competitions()


def _fetch_existing_user(connection, team_id: str, username: str):
    return connection.execute(
        """
        SELECT
            users.id AS user_id,
            users.username AS username,
            teams.id AS team_id,
            teams.name AS team_name,
            teams.invite_code AS invite_code,
            competitions.id AS competition_id,
            competitions.name AS competition_name,
            competitions.created_at AS competition_created_at
        FROM users
        JOIN teams ON teams.id = users.team_id
        JOIN competitions ON competitions.id = teams.competition_id
        WHERE users.team_id = ? AND lower(users.username) = lower(?)
        """,
        (team_id, username),
    ).fetchone()


def _fetch_existing_user_by_username(connection, competition_id: str, username: str):
    return connection.execute(
        """
        SELECT
            users.id AS user_id,
            users.username AS username,
            teams.id AS team_id,
            teams.name AS team_name,
            teams.invite_code AS invite_code,
            competitions.id AS competition_id,
            competitions.name AS competition_name,
            competitions.created_at AS competition_created_at
        FROM users
        JOIN teams ON teams.id = users.team_id
        JOIN competitions ON competitions.id = teams.competition_id
        WHERE users.competition_id = ? AND lower(users.username) = lower(?)
        ORDER BY users.created_at ASC
        LIMIT 1
        """,
        (competition_id, username),
    ).fetchone()


def _team_member_count(connection, team_id: str) -> int:
    row = connection.execute(
        """
        SELECT COUNT(*) AS member_count
        FROM users
        WHERE team_id = ?
        """,
        (team_id,),
    ).fetchone()
    return int(row["member_count"] if row else 0)


def _ensure_team_has_capacity(connection, team_id: str, team_name: str, competition_id: str) -> None:
    competition = get_competition_settings(competition_id)
    member_count = _team_member_count(connection, team_id)
    if member_count >= competition.team_member_limit:
        raise ConflictError(
            f"Team {team_name} already has the maximum of {competition.team_member_limit} members."
        )


def _fetch_session_row_by_token(connection, session_token: str):
    return connection.execute(
        """
        SELECT
            sessions.token AS session_token,
            sessions.expires_at AS expires_at,
            users.id AS user_id,
            users.username AS username,
            teams.id AS team_id,
            teams.name AS team_name,
            teams.invite_code AS invite_code,
            competitions.id AS competition_id,
            competitions.name AS competition_name,
            competitions.created_at AS competition_created_at
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        JOIN teams ON teams.id = users.team_id
        JOIN competitions ON competitions.id = teams.competition_id
        WHERE sessions.token = ?
        """,
        (session_token,),
    ).fetchone()


def _serialize_session(row) -> SessionResponse:
    competition_status = get_competition_settings(row["competition_id"])
    return SessionResponse(
        session_token=row["session_token"],
        expires_at=row["expires_at"],
        competition=CompetitionPayload(
            id=row["competition_id"],
            name=row["competition_name"],
            created_at=row["competition_created_at"],
        ),
        competition_status=competition_status,
        user=UserPayload(id=row["user_id"], username=row["username"]),
        team=TeamPayload(
            id=row["team_id"],
            name=row["team_name"],
            invite_code=row["invite_code"],
        ),
    )


def _issue_session(connection, user_id: str) -> SessionResponse:
    session_token = secrets.token_urlsafe(32)
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(hours=settings.session_duration_hours)

    connection.execute(
        """
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (session_token, user_id, expires_at.isoformat(), created_at.isoformat()),
    )
    connection.commit()

    session_row = _fetch_session_row_by_token(connection, session_token)
    return _serialize_session(session_row)


def create_team(competition_id: str, username: str, team_name: str) -> SessionResponse:
    normalized_username = _normalize_name(username, "Username")
    normalized_team_name = _normalize_name(team_name, "Team name")

    with get_connection() as connection:
        _get_competition_row(connection, competition_id)
        competition = get_competition_settings(competition_id)
        if competition.effective_status != "running":
            raise ValidationError("Only running competitions can be joined from the student entry.")

        existing_user_any_team = _fetch_existing_user_by_username(connection, competition_id, normalized_username)
        if existing_user_any_team:
            if existing_user_any_team["team_name"].lower() == normalized_team_name.lower():
                return _issue_session(connection, existing_user_any_team["user_id"])
            raise ConflictError(
                f"Username already joined team {existing_user_any_team['team_name']} in this competition. "
                "Please use that team or choose a different username."
            )

        existing_team = connection.execute(
            """
            SELECT id, name, invite_code
            FROM teams
            WHERE competition_id = ? AND lower(name) = lower(?)
            """,
            (competition_id, normalized_team_name),
        ).fetchone()
        if existing_team:
            existing_user = _fetch_existing_user(connection, existing_team["id"], normalized_username)
            if existing_user:
                return _issue_session(connection, existing_user["user_id"])
            raise ConflictError("Team name already exists in this competition. Please join it from the join panel.")

        team_id = str(uuid4())
        user_id = str(uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        invite_code = _build_team_code(normalized_team_name)

        connection.execute(
            """
            INSERT INTO teams (id, competition_id, name, invite_code, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (team_id, competition_id, normalized_team_name, invite_code, created_at),
        )
        connection.execute(
            """
            INSERT INTO users (id, username, team_id, competition_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, normalized_username, team_id, competition_id, created_at),
        )
        session = _issue_session(connection, user_id)
        connection.commit()
        return session


def join_team(competition_id: str, username: str, invite_code: str) -> SessionResponse:
    normalized_username = _normalize_name(username, "Username")
    normalized_invite_code = _normalize_invite_code(invite_code)

    with get_connection() as connection:
        _get_competition_row(connection, competition_id)
        competition = get_competition_settings(competition_id)
        if competition.effective_status != "running":
            raise ValidationError("Only running competitions can be joined from the student entry.")

        team = connection.execute(
            """
            SELECT id, name, invite_code
            FROM teams
            WHERE competition_id = ? AND upper(invite_code) = ?
            """,
            (competition_id, normalized_invite_code),
        ).fetchone()
        if not team:
            raise NotFoundError("Invite code was not found in the selected competition.")

        existing_user_any_team = _fetch_existing_user_by_username(connection, competition_id, normalized_username)
        if existing_user_any_team:
            if existing_user_any_team["team_id"] == team["id"]:
                return _issue_session(connection, existing_user_any_team["user_id"])
            raise ConflictError(
                f"Username already joined team {existing_user_any_team['team_name']} in this competition. "
                "Please use that team or choose a different username."
            )

        connection.execute("BEGIN IMMEDIATE")
        _ensure_team_has_capacity(connection, team["id"], team["name"], competition_id)

        user_id = str(uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        connection.execute(
            """
            INSERT INTO users (id, username, team_id, competition_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, normalized_username, team["id"], competition_id, created_at),
        )
        session = _issue_session(connection, user_id)
        connection.commit()
        return session


def get_session(session_token: str) -> SessionResponse:
    with get_connection() as connection:
        row = _fetch_session_row_by_token(connection, session_token)
        if not row:
            raise UnauthorizedError("Session token was not found.")

        expires_at = datetime.fromisoformat(row["expires_at"])
        now = datetime.now(timezone.utc)
        if expires_at <= now:
            connection.execute("DELETE FROM sessions WHERE token = ?", (session_token,))
            connection.commit()
            raise UnauthorizedError("Session token has expired.")

        return _serialize_session(row)


def get_authenticated_user(session_token: str) -> Dict[str, str]:
    session = get_session(session_token)
    return {
        "session_token": session.session_token,
        "expires_at": session.expires_at,
        "competition_id": session.competition.id,
        "competition_name": session.competition.name,
        "user_id": session.user.id,
        "username": session.user.username,
        "team_id": session.team.id,
        "team_name": session.team.name,
        "invite_code": session.team.invite_code,
    }
