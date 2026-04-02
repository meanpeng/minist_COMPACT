from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import settings

DEFAULT_COMPETITION_ID = "default-competition"


def _table_exists(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        """,
        (table_name,),
    ).fetchone()
    return bool(row)


def _table_columns(connection: sqlite3.Connection, table_name: str) -> set[str]:
    if not _table_exists(connection, table_name):
        return set()
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()}


def _ensure_column(connection: sqlite3.Connection, table_name: str, column_name: str, definition: str) -> None:
    if column_name not in _table_columns(connection, table_name):
        connection.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}")


def _ensure_default_competition(connection: sqlite3.Connection) -> None:
    now = datetime.now(timezone.utc).isoformat()
    connection.execute(
        """
        INSERT INTO competitions (id, name, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        """,
        (DEFAULT_COMPETITION_ID, "MNIST Classroom Challenge", now),
    )


def _migrate_competition_settings(connection: sqlite3.Connection) -> None:
    columns = _table_columns(connection, "competition_settings")
    if "competition_id" in columns:
        return

    legacy_rows = []
    if _table_exists(connection, "competition_settings"):
        legacy_rows = connection.execute(
            """
            SELECT *
            FROM competition_settings
            """
        ).fetchall()
        connection.execute("ALTER TABLE competition_settings RENAME TO competition_settings_legacy")

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS competition_settings (
            competition_id TEXT PRIMARY KEY,
            competition_name TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            manual_status TEXT,
            annotation_goal INTEGER NOT NULL,
            submission_limit INTEGER NOT NULL,
            submission_cooldown_minutes INTEGER NOT NULL,
            allow_submission INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
        )
        """
    )

    now = datetime.now(timezone.utc).isoformat()
    if legacy_rows:
        row = legacy_rows[0]
        connection.execute(
            """
            INSERT INTO competition_settings (
                competition_id,
                competition_name,
                start_time,
                end_time,
                manual_status,
                annotation_goal,
                submission_limit,
                submission_cooldown_minutes,
                allow_submission,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                DEFAULT_COMPETITION_ID,
                row["competition_name"],
                row["start_time"],
                row["end_time"],
                row["manual_status"],
                row["annotation_goal"],
                row["submission_limit"],
                row["submission_cooldown_minutes"],
                row["allow_submission"],
                row["created_at"],
                row["updated_at"],
            ),
        )
        connection.execute("DROP TABLE competition_settings_legacy")
    else:
        connection.execute(
            """
            INSERT INTO competition_settings (
                competition_id,
                competition_name,
                start_time,
                end_time,
                manual_status,
                annotation_goal,
                submission_limit,
                submission_cooldown_minutes,
                allow_submission,
                created_at,
                updated_at
            )
            VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(competition_id) DO NOTHING
            """,
            (
                DEFAULT_COMPETITION_ID,
                "MNIST Classroom Challenge",
                settings.team_annotation_goal,
                settings.submission_team_max_attempts,
                settings.submission_cooldown_minutes,
                now,
                now,
            ),
        )


def _migrate_teams_and_users(connection: sqlite3.Connection) -> None:
    team_columns = _table_columns(connection, "teams")
    user_columns = _table_columns(connection, "users")
    if "competition_id" in team_columns and "competition_id" in user_columns:
        return

    # End any active transaction before toggling foreign key enforcement. SQLite
    # ignores PRAGMA foreign_keys changes while a transaction is open.
    connection.commit()
    connection.execute("PRAGMA foreign_keys = OFF")

    team_source_table = "teams"
    user_source_table = "users"

    if "competition_id" not in team_columns:
        if _table_exists(connection, "teams_legacy"):
            team_source_table = "teams_legacy"
        elif _table_exists(connection, "teams"):
            connection.execute("ALTER TABLE teams RENAME TO teams_legacy")
            team_source_table = "teams_legacy"
        else:
            team_source_table = ""

    if "competition_id" not in user_columns:
        if _table_exists(connection, "users_legacy"):
            user_source_table = "users_legacy"
        elif _table_exists(connection, "users"):
            connection.execute("ALTER TABLE users RENAME TO users_legacy")
            user_source_table = "users_legacy"
        else:
            user_source_table = ""

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS teams (
            id TEXT PRIMARY KEY,
            competition_id TEXT NOT NULL,
            name TEXT NOT NULL,
            invite_code TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
            UNIQUE(competition_id, name)
        )
        """
    )

    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            team_id TEXT NOT NULL,
            competition_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
            FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
            UNIQUE(username, competition_id)
        )
        """
    )

    if team_source_table == "teams_legacy":
        connection.execute(
            """
            INSERT OR IGNORE INTO teams (id, competition_id, name, invite_code, created_at)
            SELECT id, ?, name, invite_code, created_at
            FROM teams_legacy
            """,
            (DEFAULT_COMPETITION_ID,),
        )

    if user_source_table == "users_legacy":
        connection.execute(
            """
            INSERT OR IGNORE INTO users (id, username, team_id, competition_id, created_at)
            SELECT u.id, u.username, u.team_id, ?, u.created_at
            FROM users_legacy u
            """,
            (DEFAULT_COMPETITION_ID,),
        )

    for table_name in ("users_legacy", "teams_legacy"):
        if _table_exists(connection, table_name):
            connection.execute(f"DROP TABLE IF EXISTS {table_name}")

    connection.commit()
    connection.execute("PRAGMA foreign_keys = ON")


def _ensure_competition_column(connection: sqlite3.Connection, table_name: str, fill_sql: str) -> None:
    if "competition_id" in _table_columns(connection, table_name):
        return
    connection.execute(f"ALTER TABLE {table_name} ADD COLUMN competition_id TEXT")
    connection.execute(fill_sql)


def _backfill_competition_columns(connection: sqlite3.Connection) -> None:
    _ensure_competition_column(
        connection,
        "annotations",
        """
        UPDATE annotations
        SET competition_id = (
            SELECT competition_id
            FROM teams
            WHERE teams.id = annotations.team_id
        )
        WHERE competition_id IS NULL
        """,
    )
    _ensure_competition_column(
        connection,
        "user_model_configs",
        """
        UPDATE user_model_configs
        SET competition_id = (
            SELECT competition_id
            FROM users
            WHERE users.id = user_model_configs.user_id
        )
        WHERE competition_id IS NULL
        """,
    )
    _ensure_competition_column(
        connection,
        "user_training_runs",
        """
        UPDATE user_training_runs
        SET competition_id = (
            SELECT competition_id
            FROM users
            WHERE users.id = user_training_runs.user_id
        )
        WHERE competition_id IS NULL
        """,
    )
    _ensure_competition_column(
        connection,
        "submission_challenges",
        """
        UPDATE submission_challenges
        SET competition_id = (
            SELECT competition_id
            FROM users
            WHERE users.id = submission_challenges.user_id
        )
        WHERE competition_id IS NULL
        """,
    )
    _ensure_competition_column(
        connection,
        "submission_results",
        """
        UPDATE submission_results
        SET competition_id = (
            SELECT competition_id
            FROM users
            WHERE users.id = submission_results.user_id
        )
        WHERE competition_id IS NULL
        """,
    )


def init_db() -> None:
    settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    settings.annotation_storage_path.mkdir(parents=True, exist_ok=True)
    settings.mnist_storage_path.mkdir(parents=True, exist_ok=True)

    with get_connection() as connection:
        connection.executescript(
            """
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS competitions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS teams (
                id TEXT PRIMARY KEY,
                competition_id TEXT NOT NULL,
                name TEXT NOT NULL,
                invite_code TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
                UNIQUE(competition_id, name)
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
                UNIQUE(username, competition_id)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                label INTEGER NOT NULL CHECK(label >= 0 AND label <= 9),
                image_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_model_configs (
                user_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_training_runs (
                user_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                batch_size INTEGER NOT NULL,
                epochs INTEGER NOT NULL,
                learning_rate REAL NOT NULL,
                trained_sample_count INTEGER NOT NULL,
                final_loss REAL,
                final_accuracy REAL,
                final_val_loss REAL,
                final_val_accuracy REAL,
                logs_json TEXT NOT NULL,
                backend TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS submission_challenges (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                sample_indexes_json TEXT NOT NULL,
                used_at TEXT,
                expires_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS submission_results (
                id TEXT PRIMARY KEY,
                submission_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                team_id TEXT NOT NULL,
                competition_id TEXT NOT NULL,
                accuracy REAL NOT NULL,
                correct_count INTEGER NOT NULL,
                sample_count INTEGER NOT NULL,
                param_count INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (submission_id) REFERENCES submission_challenges(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS competition_settings (
                competition_id TEXT PRIMARY KEY,
                competition_name TEXT NOT NULL,
                start_time TEXT,
                end_time TEXT,
                manual_status TEXT,
                annotation_goal INTEGER NOT NULL,
                submission_limit INTEGER NOT NULL,
                submission_cooldown_minutes INTEGER NOT NULL,
                allow_submission INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
            );
            """
        )

        _ensure_default_competition(connection)
        _migrate_competition_settings(connection)
        _migrate_teams_and_users(connection)
        _backfill_competition_columns(connection)

        _ensure_column(connection, "submission_challenges", "used_at", "TEXT")
        _ensure_column(connection, "submission_challenges", "expires_at", "TEXT")

        now = datetime.now(timezone.utc).isoformat()
        connection.execute(
            """
            INSERT INTO competition_settings (
                competition_id,
                competition_name,
                start_time,
                end_time,
                manual_status,
                annotation_goal,
                submission_limit,
                submission_cooldown_minutes,
                allow_submission,
                created_at,
                updated_at
            )
            VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(competition_id) DO NOTHING
            """,
            (
                DEFAULT_COMPETITION_ID,
                "MNIST Classroom Challenge",
                settings.team_annotation_goal,
                settings.submission_team_max_attempts,
                settings.submission_cooldown_minutes,
                now,
                now,
            ),
        )

        connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id
            ON sessions(user_id);

            CREATE INDEX IF NOT EXISTS idx_teams_competition_id
            ON teams(competition_id);

            CREATE INDEX IF NOT EXISTS idx_users_competition_id
            ON users(competition_id);

            CREATE INDEX IF NOT EXISTS idx_users_team_id
            ON users(team_id);

            CREATE INDEX IF NOT EXISTS idx_annotations_team_id
            ON annotations(team_id);

            CREATE INDEX IF NOT EXISTS idx_annotations_competition_id
            ON annotations(competition_id);

            CREATE INDEX IF NOT EXISTS idx_annotations_team_label
            ON annotations(team_id, label);

            CREATE INDEX IF NOT EXISTS idx_submission_challenges_user_id
            ON submission_challenges(user_id);

            CREATE INDEX IF NOT EXISTS idx_submission_challenges_competition_id
            ON submission_challenges(competition_id);

            CREATE INDEX IF NOT EXISTS idx_submission_results_team_accuracy
            ON submission_results(team_id, accuracy DESC, param_count ASC, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_submission_results_competition_accuracy
            ON submission_results(competition_id, accuracy DESC, param_count ASC, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_submission_results_user_created_at
            ON submission_results(user_id, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_submission_results_team_created_at
            ON submission_results(team_id, created_at DESC);
            """
        )

        connection.commit()


@contextmanager
def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(settings.database_path)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()
