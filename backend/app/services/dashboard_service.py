from __future__ import annotations

from typing import Dict, List, Optional

from ..database import get_connection
from ..errors import NotFoundError
from ..schemas import (
    CompetitionPayload,
    DashboardLatestValidationPayload,
    DashboardLeaderboardEntryPayload,
    DashboardRankingPayload,
    DashboardResponse,
    SessionResponse,
    TeamAnnotationStatsResponse,
    TeamPayload,
    UserPayload,
)
from .auth_service import get_authenticated_user
from .competition_service import get_competition_settings


def _serialize_session(row, session_token: str, expires_at: str) -> SessionResponse:
    return SessionResponse(
        session_token=session_token,
        expires_at=expires_at,
        competition=CompetitionPayload(
            id=row["competition_id"],
            name=row["competition_name"],
            created_at=row["competition_created_at"],
        ),
        user=UserPayload(id=row["user_id"], username=row["username"]),
        team=TeamPayload(
            id=row["team_id"],
            name=row["team_name"],
            invite_code=row["invite_code"],
        ),
    )


def _build_annotation_stats(connection, team_id: str, goal: int) -> TeamAnnotationStatsResponse:
    counts = [0] * 10
    rows = connection.execute(
        """
        SELECT label, COUNT(*) AS count
        FROM annotations
        WHERE team_id = ?
        GROUP BY label
        ORDER BY label ASC
        """,
        (team_id,),
    ).fetchall()

    total_count = 0
    for row in rows:
        counts[row["label"]] = row["count"]
        total_count += row["count"]

    remaining_to_goal = max(goal - total_count, 0)
    progress_ratio = min(total_count / goal, 1) if goal else 0
    return TeamAnnotationStatsResponse(
        team_id=team_id,
        total_count=total_count,
        goal=goal,
        remaining_to_goal=remaining_to_goal,
        progress_ratio=progress_ratio,
        counts_by_label=counts,
    )


def _fetch_team_members(connection, team_id: str) -> List[UserPayload]:
    rows = connection.execute(
        """
        SELECT id, username
        FROM users
        WHERE team_id = ?
        ORDER BY username COLLATE NOCASE ASC
        """,
        (team_id,),
    ).fetchall()
    return [UserPayload(id=row["id"], username=row["username"]) for row in rows]


def _fetch_member_map(connection, competition_id: str) -> Dict[str, List[str]]:
    rows = connection.execute(
        """
        SELECT team_id, username
        FROM users
        WHERE competition_id = ?
        ORDER BY team_id ASC, username COLLATE NOCASE ASC
        """,
        (competition_id,),
    ).fetchall()

    member_map: Dict[str, List[str]] = {}
    for row in rows:
        member_map.setdefault(row["team_id"], []).append(row["username"])
    return member_map


def _fetch_previous_best_accuracy(
    connection, competition_id: str, team_id: str, latest_created_at: Optional[str]
) -> Optional[float]:
    if not latest_created_at:
        return None

    row = connection.execute(
        """
        SELECT MAX(accuracy) AS previous_best_accuracy
        FROM submission_results
        WHERE competition_id = ? AND team_id = ? AND created_at < ?
        """,
        (competition_id, team_id, latest_created_at),
    ).fetchone()
    if not row:
        return None
    return row["previous_best_accuracy"]


def _fetch_leaderboard(
    connection, competition_id: str, current_team_id: str, member_map: Dict[str, List[str]]
) -> List[DashboardLeaderboardEntryPayload]:
    rows = connection.execute(
        """
        WITH best_results AS (
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
        SELECT team_id, team_name, accuracy, submitted_by, created_at
        FROM best_results
        WHERE team_rank = 1
        ORDER BY accuracy DESC, param_count ASC, created_at ASC
        LIMIT 10
        """,
        (competition_id,),
    ).fetchall()

    entries: List[DashboardLeaderboardEntryPayload] = []
    for index, row in enumerate(rows, start=1):
        latest_rows = connection.execute(
            """
            SELECT accuracy
            FROM submission_results
            WHERE competition_id = ? AND team_id = ?
            ORDER BY created_at DESC
            LIMIT 2
            """,
            (competition_id, row["team_id"]),
        ).fetchall()
        latest_accuracy = latest_rows[0]["accuracy"] if latest_rows else None
        previous_accuracy = latest_rows[1]["accuracy"] if len(latest_rows) > 1 else None

        status = "Stable"
        if row["team_id"] == current_team_id:
            status = "Your_Team"
        elif latest_accuracy is not None and previous_accuracy is not None:
            if latest_accuracy > previous_accuracy:
                status = "Climbing"
            elif latest_accuracy < previous_accuracy:
                status = "Falling"

        entries.append(
            DashboardLeaderboardEntryPayload(
                rank=index,
                team_id=row["team_id"],
                team_name=row["team_name"],
                member_names=member_map.get(row["team_id"], []),
                accuracy=row["accuracy"],
                status=status,
                submitted_by=row["submitted_by"],
                created_at=row["created_at"],
                is_current_team=row["team_id"] == current_team_id,
            )
        )

    return entries


def _fetch_current_rank(connection, competition_id: str, team_id: str) -> Optional[int]:
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


def get_dashboard(session_token: str, annotation_goal: int) -> DashboardResponse:
    auth = get_authenticated_user(session_token)
    competition = get_competition_settings(auth["competition_id"])

    with get_connection() as connection:
        session_row = connection.execute(
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
            WHERE users.id = ?
            """,
            (auth["user_id"],),
        ).fetchone()
        if not session_row:
            raise NotFoundError("Session user was not found.")

        session = _serialize_session(
            session_row,
            session_token=auth["session_token"],
            expires_at=auth["expires_at"],
        )
        team_members = _fetch_team_members(connection, session.team.id)
        annotation_stats = _build_annotation_stats(connection, session.team.id, competition.annotation_goal)

        latest_result_row = connection.execute(
            """
            SELECT
                sr.accuracy,
                sr.sample_count,
                sr.created_at,
                u.username AS submitted_by
            FROM submission_results sr
            JOIN users u ON u.id = sr.user_id
            WHERE sr.team_id = ?
            ORDER BY sr.created_at DESC
            LIMIT 1
            """,
            (session.team.id,),
        ).fetchone()
        previous_best_accuracy = _fetch_previous_best_accuracy(
            connection,
            auth["competition_id"],
            session.team.id,
            latest_result_row["created_at"] if latest_result_row else None,
        )

        ranked_team_count = connection.execute(
            """
            SELECT COUNT(DISTINCT team_id) AS total_ranked_teams
            FROM submission_results
            WHERE competition_id = ?
            """,
            (auth["competition_id"],),
        ).fetchone()["total_ranked_teams"]

        member_map = _fetch_member_map(connection, auth["competition_id"])
        leaderboard = _fetch_leaderboard(connection, auth["competition_id"], session.team.id, member_map)
        current_rank = _fetch_current_rank(connection, auth["competition_id"], session.team.id)
        percentile = None
        if current_rank is not None and ranked_team_count:
            percentile = current_rank / ranked_team_count

    return DashboardResponse(
        session=session,
        competition=competition,
        team_members=team_members,
        annotation_stats=annotation_stats,
        ranking=DashboardRankingPayload(
            rank=current_rank,
            total_ranked_teams=ranked_team_count,
            percentile=percentile,
        ),
        latest_validation=DashboardLatestValidationPayload(
            latest_accuracy=latest_result_row["accuracy"] if latest_result_row else None,
            previous_best_accuracy=previous_best_accuracy,
            submitted_at=latest_result_row["created_at"] if latest_result_row else None,
            submitted_by=latest_result_row["submitted_by"] if latest_result_row else None,
            sample_count=latest_result_row["sample_count"] if latest_result_row else None,
        ),
        leaderboard=leaderboard,
    )
