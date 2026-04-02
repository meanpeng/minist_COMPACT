from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from ..config import settings
from ..database import get_connection
from ..errors import NotFoundError
from ..schemas import (
    AdminAnnotationSamplePayload,
    AdminBootstrapResponse,
    AdminLeaderboardEntryPayload,
    AdminMemberContributionPayload,
    AdminMemberPayload,
    AdminOverviewPayload,
    AdminSubmissionPayload,
    AdminTeamDetailPayload,
    AdminTeamPayload,
    SubmissionScorePayload,
)
from .auth_service import _build_team_code
from .competition_service import (
    build_competition_payload,
    create_competition,
    get_competition_settings,
    list_competition_statuses_for_admin,
    set_manual_competition_status,
    update_competition_settings,
)

ANNOTATION_SAMPLE_LIMIT = 240
SUBMISSION_RECORD_LIMIT = 240
RECENT_SUBMISSION_LIMIT = 8


def _remove_annotation_file(relative_path: str) -> None:
    file_path = (settings.annotation_storage_path / Path(relative_path)).resolve()
    try:
        file_path.relative_to(settings.annotation_storage_path.resolve())
    except ValueError:
        return

    if file_path.exists():
        file_path.unlink()


def _serialize_submission_row(row) -> AdminSubmissionPayload:
    return AdminSubmissionPayload(
        id=row["id"],
        submission_id=row["submission_id"],
        team_id=row["team_id"],
        team_name=row["team_name"],
        user_id=row["user_id"],
        username=row["username"],
        accuracy=row["accuracy"],
        correct_count=row["correct_count"],
        sample_count=row["sample_count"],
        param_count=row["param_count"],
        created_at=row["created_at"],
    )


def _serialize_score_row(row) -> SubmissionScorePayload:
    return SubmissionScorePayload(
        accuracy=row["accuracy"],
        param_count=row["param_count"],
        team_id=row["team_id"],
        team_name=row["team_name"],
        submitted_by=row["submitted_by"],
        created_at=row["created_at"],
    )


def _pick_competition_id(connection, requested_competition_id: Optional[str]) -> str:
    if requested_competition_id:
        existing = connection.execute(
            """
            SELECT id
            FROM competitions
            WHERE id = ?
            """,
            (requested_competition_id,),
        ).fetchone()
        if not existing:
            raise NotFoundError("Competition was not found.")
        return requested_competition_id

    rows = connection.execute(
        """
        SELECT *
        FROM competition_settings
        ORDER BY updated_at DESC, created_at DESC
        """
    ).fetchall()
    if not rows:
        raise NotFoundError("No competitions were found.")
    for item in rows:
        if build_competition_payload(item).effective_status == "running":
            return item["competition_id"]
    return rows[0]["competition_id"]


def get_admin_bootstrap(competition_id: Optional[str] = None) -> AdminBootstrapResponse:
    with get_connection() as connection:
        selected_competition_id = _pick_competition_id(connection, competition_id)
        competition = get_competition_settings(selected_competition_id)

        team_rows = connection.execute(
            """
            WITH team_members AS (
                SELECT team_id, COUNT(*) AS member_count
                FROM users
                WHERE competition_id = ?
                GROUP BY team_id
            ),
            team_annotations AS (
                SELECT
                    team_id,
                    COUNT(*) AS annotation_count,
                    SUM(CASE WHEN label = 0 THEN 1 ELSE 0 END) AS c0,
                    SUM(CASE WHEN label = 1 THEN 1 ELSE 0 END) AS c1,
                    SUM(CASE WHEN label = 2 THEN 1 ELSE 0 END) AS c2,
                    SUM(CASE WHEN label = 3 THEN 1 ELSE 0 END) AS c3,
                    SUM(CASE WHEN label = 4 THEN 1 ELSE 0 END) AS c4,
                    SUM(CASE WHEN label = 5 THEN 1 ELSE 0 END) AS c5,
                    SUM(CASE WHEN label = 6 THEN 1 ELSE 0 END) AS c6,
                    SUM(CASE WHEN label = 7 THEN 1 ELSE 0 END) AS c7,
                    SUM(CASE WHEN label = 8 THEN 1 ELSE 0 END) AS c8,
                    SUM(CASE WHEN label = 9 THEN 1 ELSE 0 END) AS c9
                FROM annotations
                WHERE competition_id = ?
                GROUP BY team_id
            ),
            team_submission_counts AS (
                SELECT team_id, COUNT(*) AS submission_count
                FROM submission_results
                WHERE competition_id = ?
                GROUP BY team_id
            ),
            ranked_results AS (
                SELECT
                    sr.team_id,
                    sr.accuracy,
                    sr.param_count,
                    sr.created_at,
                    u.username AS submitted_by,
                    ROW_NUMBER() OVER (
                        PARTITION BY sr.team_id
                        ORDER BY sr.accuracy DESC, sr.param_count ASC, sr.created_at ASC
                    ) AS team_rank
                FROM submission_results sr
                JOIN users u ON u.id = sr.user_id
                WHERE sr.competition_id = ?
            )
            SELECT
                t.id,
                t.name,
                t.invite_code,
                t.created_at,
                COALESCE(tm.member_count, 0) AS member_count,
                COALESCE(ta.annotation_count, 0) AS annotation_count,
                COALESCE(ta.c0, 0) AS c0,
                COALESCE(ta.c1, 0) AS c1,
                COALESCE(ta.c2, 0) AS c2,
                COALESCE(ta.c3, 0) AS c3,
                COALESCE(ta.c4, 0) AS c4,
                COALESCE(ta.c5, 0) AS c5,
                COALESCE(ta.c6, 0) AS c6,
                COALESCE(ta.c7, 0) AS c7,
                COALESCE(ta.c8, 0) AS c8,
                COALESCE(ta.c9, 0) AS c9,
                COALESCE(tsc.submission_count, 0) AS submission_count,
                rr.accuracy AS best_accuracy,
                rr.param_count AS best_param_count,
                rr.created_at AS best_submitted_at,
                rr.submitted_by AS best_submitted_by
            FROM teams t
            LEFT JOIN team_members tm ON tm.team_id = t.id
            LEFT JOIN team_annotations ta ON ta.team_id = t.id
            LEFT JOIN team_submission_counts tsc ON tsc.team_id = t.id
            LEFT JOIN ranked_results rr ON rr.team_id = t.id AND rr.team_rank = 1
            WHERE t.competition_id = ?
            ORDER BY annotation_count DESC, member_count DESC, t.created_at ASC
            """,
            (
                selected_competition_id,
                selected_competition_id,
                selected_competition_id,
                selected_competition_id,
                selected_competition_id,
            ),
        ).fetchall()

        teams = []
        qualified_team_count = 0
        for row in team_rows:
            counts_by_label = [row[f"c{index}"] for index in range(10)]
            remaining_to_goal = max(competition.annotation_goal - row["annotation_count"], 0)
            has_reached_goal = row["annotation_count"] >= competition.annotation_goal
            if has_reached_goal:
                qualified_team_count += 1

            teams.append(
                AdminTeamPayload(
                    id=row["id"],
                    name=row["name"],
                    invite_code=row["invite_code"],
                    created_at=row["created_at"],
                    member_count=row["member_count"],
                    annotation_count=row["annotation_count"],
                    remaining_to_goal=remaining_to_goal,
                    counts_by_label=counts_by_label,
                    has_reached_goal=has_reached_goal,
                    submission_count=row["submission_count"],
                    remaining_submission_attempts=max(competition.submission_limit - row["submission_count"], 0),
                    best_accuracy=row["best_accuracy"],
                    best_param_count=row["best_param_count"],
                    best_submitted_at=row["best_submitted_at"],
                    best_submitted_by=row["best_submitted_by"],
                )
            )

        member_rows = connection.execute(
            """
            WITH member_annotation_counts AS (
                SELECT user_id, COUNT(*) AS annotation_count
                FROM annotations
                WHERE competition_id = ?
                GROUP BY user_id
            ),
            member_submission_counts AS (
                SELECT user_id, COUNT(*) AS submission_count
                FROM submission_results
                WHERE competition_id = ?
                GROUP BY user_id
            )
            SELECT
                u.id,
                u.username,
                u.team_id,
                t.name AS team_name,
                u.created_at,
                COALESCE(mac.annotation_count, 0) AS annotation_count,
                COALESCE(msc.submission_count, 0) AS submission_count
            FROM users u
            JOIN teams t ON t.id = u.team_id
            LEFT JOIN member_annotation_counts mac ON mac.user_id = u.id
            LEFT JOIN member_submission_counts msc ON msc.user_id = u.id
            WHERE u.competition_id = ?
            ORDER BY t.name COLLATE NOCASE ASC, u.username COLLATE NOCASE ASC
            """,
            (selected_competition_id, selected_competition_id, selected_competition_id),
        ).fetchall()
        members = [
            AdminMemberPayload(
                id=row["id"],
                username=row["username"],
                team_id=row["team_id"],
                team_name=row["team_name"],
                created_at=row["created_at"],
                annotation_count=row["annotation_count"],
                submission_count=row["submission_count"],
            )
            for row in member_rows
        ]

        contribution_rows = connection.execute(
            """
            SELECT
                u.team_id,
                u.id AS user_id,
                u.username,
                COUNT(a.id) AS annotation_count
            FROM users u
            LEFT JOIN annotations a ON a.user_id = u.id AND a.competition_id = u.competition_id
            WHERE u.competition_id = ?
            GROUP BY u.team_id, u.id, u.username
            ORDER BY u.team_id ASC, annotation_count DESC, u.username COLLATE NOCASE ASC
            """,
            (selected_competition_id,),
        ).fetchall()
        contribution_map: Dict[str, List[AdminMemberContributionPayload]] = {}
        for row in contribution_rows:
            contribution_map.setdefault(row["team_id"], []).append(
                AdminMemberContributionPayload(
                    user_id=row["user_id"],
                    username=row["username"],
                    annotation_count=row["annotation_count"],
                )
            )

        team_details = [
            AdminTeamDetailPayload(team_id=team.id, member_contributions=contribution_map.get(team.id, []))
            for team in teams
        ]

        annotation_rows = connection.execute(
            """
            SELECT
                a.id,
                a.team_id,
                t.name AS team_name,
                a.user_id,
                u.username,
                a.label,
                a.image_path,
                a.created_at
            FROM annotations a
            JOIN teams t ON t.id = a.team_id
            JOIN users u ON u.id = a.user_id
            WHERE a.competition_id = ?
            ORDER BY a.created_at DESC
            LIMIT ?
            """,
            (selected_competition_id, ANNOTATION_SAMPLE_LIMIT),
        ).fetchall()
        annotation_samples = [
            AdminAnnotationSamplePayload(
                id=row["id"],
                team_id=row["team_id"],
                team_name=row["team_name"],
                user_id=row["user_id"],
                username=row["username"],
                label=row["label"],
                image_url=f"/api/assets/annotations/{row['image_path']}",
                created_at=row["created_at"],
            )
            for row in annotation_rows
        ]

        submission_rows = connection.execute(
            """
            SELECT
                sr.id,
                sr.submission_id,
                sr.team_id,
                t.name AS team_name,
                sr.user_id,
                u.username,
                sr.accuracy,
                sr.correct_count,
                sr.sample_count,
                sr.param_count,
                sr.created_at
            FROM submission_results sr
            JOIN teams t ON t.id = sr.team_id
            JOIN users u ON u.id = sr.user_id
            WHERE sr.competition_id = ?
            ORDER BY sr.created_at DESC
            LIMIT ?
            """,
            (selected_competition_id, SUBMISSION_RECORD_LIMIT),
        ).fetchall()
        submissions = [_serialize_submission_row(row) for row in submission_rows]

        leaderboard_rows = connection.execute(
            """
            WITH best_results AS (
                SELECT
                    sr.team_id,
                    t.name AS team_name,
                    sr.accuracy,
                    sr.param_count,
                    sr.created_at,
                    u.username AS submitted_by,
                    ROW_NUMBER() OVER (
                        PARTITION BY sr.team_id
                        ORDER BY sr.accuracy DESC, sr.param_count ASC, sr.created_at ASC
                    ) AS team_rank
                FROM submission_results sr
                JOIN teams t ON t.id = sr.team_id
                JOIN users u ON u.id = sr.user_id
                WHERE sr.competition_id = ?
            ),
            submission_counts AS (
                SELECT team_id, COUNT(*) AS submission_count
                FROM submission_results
                WHERE competition_id = ?
                GROUP BY team_id
            )
            SELECT
                br.team_id,
                br.team_name,
                br.accuracy,
                br.param_count,
                br.submitted_by,
                br.created_at,
                COALESCE(sc.submission_count, 0) AS submission_count
            FROM best_results br
            LEFT JOIN submission_counts sc ON sc.team_id = br.team_id
            WHERE br.team_rank = 1
            ORDER BY br.accuracy DESC, br.param_count ASC, br.created_at ASC
            """,
            (selected_competition_id, selected_competition_id),
        ).fetchall()
        leaderboard = [
            AdminLeaderboardEntryPayload(
                rank=index,
                team_id=row["team_id"],
                team_name=row["team_name"],
                accuracy=row["accuracy"],
                param_count=row["param_count"],
                submitted_by=row["submitted_by"],
                created_at=row["created_at"],
                submission_count=row["submission_count"],
            )
            for index, row in enumerate(leaderboard_rows, start=1)
        ]

        current_leader = _serialize_score_row(leaderboard_rows[0]) if leaderboard_rows else None

        recent_submission_rows = connection.execute(
            """
            SELECT
                sr.id,
                sr.submission_id,
                sr.team_id,
                t.name AS team_name,
                sr.user_id,
                u.username,
                sr.accuracy,
                sr.correct_count,
                sr.sample_count,
                sr.param_count,
                sr.created_at
            FROM submission_results sr
            JOIN teams t ON t.id = sr.team_id
            JOIN users u ON u.id = sr.user_id
            WHERE sr.competition_id = ?
            ORDER BY sr.created_at DESC
            LIMIT ?
            """,
            (selected_competition_id, RECENT_SUBMISSION_LIMIT),
        ).fetchall()

        overview = AdminOverviewPayload(
            competition=competition,
            team_count=len(teams),
            member_count=len(members),
            annotation_count=sum(team.annotation_count for team in teams),
            qualified_team_count=qualified_team_count,
            submitted_team_count=len(leaderboard),
            current_leader=current_leader,
            recent_submissions=[_serialize_submission_row(row) for row in recent_submission_rows],
        )

    competitions = list_competition_statuses_for_admin(selected_competition_id)

    return AdminBootstrapResponse(
        competitions=competitions,
        selected_competition_id=selected_competition_id,
        settings=competition,
        overview=overview,
        teams=teams,
        members=members,
        team_details=team_details,
        annotation_samples=annotation_samples,
        submissions=submissions,
        leaderboard=leaderboard,
    )


def create_admin_competition(competition_name: str) -> AdminBootstrapResponse:
    competition = create_competition(competition_name)
    return get_admin_bootstrap(competition.id)


def update_admin_settings(**payload):
    return update_competition_settings(**payload)


def start_competition(competition_id: str):
    return set_manual_competition_status(competition_id, "running")


def end_competition(competition_id: str):
    return set_manual_competition_status(competition_id, "ended")


def reset_team_invite_code(competition_id: str, team_id: str):
    with get_connection() as connection:
        team_row = connection.execute(
            """
            SELECT name
            FROM teams
            WHERE id = ? AND competition_id = ?
            """,
            (team_id, competition_id),
        ).fetchone()
        if not team_row:
            raise NotFoundError("Team was not found.")

        new_code = _build_team_code(team_row["name"])
        connection.execute(
            """
            UPDATE teams
            SET invite_code = ?
            WHERE id = ? AND competition_id = ?
            """,
            (new_code, team_id, competition_id),
        )
        connection.commit()

    return get_admin_bootstrap(competition_id)


def delete_team(competition_id: str, team_id: str):
    with get_connection() as connection:
        annotation_rows = connection.execute(
            """
            SELECT image_path
            FROM annotations
            WHERE competition_id = ? AND team_id = ?
            """,
            (competition_id, team_id),
        ).fetchall()
        deleted = connection.execute(
            """
            DELETE FROM teams
            WHERE id = ? AND competition_id = ?
            """,
            (team_id, competition_id),
        ).rowcount
        if deleted != 1:
            raise NotFoundError("Team was not found.")
        connection.commit()

    for row in annotation_rows:
        _remove_annotation_file(row["image_path"])

    return get_admin_bootstrap(competition_id)


def delete_member(competition_id: str, user_id: str):
    with get_connection() as connection:
        annotation_rows = connection.execute(
            """
            SELECT image_path
            FROM annotations
            WHERE competition_id = ? AND user_id = ?
            """,
            (competition_id, user_id),
        ).fetchall()
        deleted = connection.execute(
            """
            DELETE FROM users
            WHERE id = ? AND competition_id = ?
            """,
            (user_id, competition_id),
        ).rowcount
        if deleted != 1:
            raise NotFoundError("Member was not found.")
        connection.commit()

    for row in annotation_rows:
        _remove_annotation_file(row["image_path"])

    return get_admin_bootstrap(competition_id)


def delete_annotation(competition_id: str, annotation_id: str):
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT image_path
            FROM annotations
            WHERE id = ? AND competition_id = ?
            """,
            (annotation_id, competition_id),
        ).fetchone()
        if not row:
            raise NotFoundError("Annotation sample was not found.")
        connection.execute(
            """
            DELETE FROM annotations
            WHERE id = ? AND competition_id = ?
            """,
            (annotation_id, competition_id),
        )
        connection.commit()

    _remove_annotation_file(row["image_path"])
    return get_admin_bootstrap(competition_id)


def delete_submission(competition_id: str, submission_result_id: str):
    with get_connection() as connection:
        deleted = connection.execute(
            """
            DELETE FROM submission_results
            WHERE id = ? AND competition_id = ?
            """,
            (submission_result_id, competition_id),
        ).rowcount
        if deleted != 1:
            raise NotFoundError("Submission record was not found.")
        connection.commit()

    return get_admin_bootstrap(competition_id)
