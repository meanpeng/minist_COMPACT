from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4
import unittest

from backend.app.errors import ValidationError
from backend.app.services.auth_service import create_team, join_team
from backend.app.services.competition_service import (
    _validate_single_running_competition,
    build_competition_payload,
    create_competition,
    ensure_submissions_open,
    update_competition_settings,
)
from backend.app.services.modeling_service import _build_summary, _normalize_layers
from backend.app.services.submission_service import _validate_submission_limits
from backend.app.database import get_connection
from backend.tests.test_utils import patched_backend_environment
from backend.app.schemas import ModelLayerPayload


class CompetitionRuleTests(unittest.TestCase):
    def test_build_competition_payload_derives_status(self):
        current_time = datetime(2026, 4, 3, 8, 0, tzinfo=timezone.utc)
        row = {
            "competition_id": "c1",
            "competition_name": "Demo",
            "start_time": None,
            "end_time": (current_time - timedelta(minutes=1)).isoformat(),
            "manual_status": None,
            "annotation_goal": 50,
            "team_member_limit": 5,
            "submission_limit": 10,
            "submission_cooldown_minutes": 5,
            "allow_submission": 1,
        }

        payload = build_competition_payload(row, now=current_time)

        self.assertEqual(payload.effective_status, "ended")
        self.assertIsNone(payload.seconds_until_end)
        self.assertFalse(payload.is_submission_open)

    def test_single_running_competition_is_enforced(self):
        with patched_backend_environment():
            create_competition("Second Competition")

            try:
                update_competition_settings(
                    competition_id="default-competition",
                    competition_name="MNIST Classroom Challenge",
                    end_time=None,
                    manual_status="running",
                    annotation_goal=3,
                    team_member_limit=2,
                    submission_limit=1,
                    submission_cooldown_minutes=0,
                    allow_submission=True,
                )
            except ValidationError as exc:
                self.assertIn("Another competition is already running", str(exc))
            else:
                self.fail("Expected running competition validation to fail.")

    def test_modeling_layer_normalization_and_summary(self):
        layers = _normalize_layers(
            [
                ModelLayerPayload(id="dense-1", type="dense", units=32, activation="relu"),
                ModelLayerPayload(id="dense-2", type="dense", units=32, activation="relu"),
            ]
        )

        summary = _build_summary(layers)

        self.assertEqual(summary.hidden_layer_count, 2)
        self.assertGreater(summary.param_count, 0)
        self.assertEqual(summary.output_classes, 10)

    def test_modeling_rejects_duplicate_layer_ids(self):
        try:
            _normalize_layers(
                [
                    ModelLayerPayload(id="dup", type="dense", units=32, activation="relu"),
                    ModelLayerPayload(id="dup", type="dense", units=64, activation="relu"),
                ]
            )
        except ValidationError as exc:
            self.assertIn("Layer ids must be unique", str(exc))
        else:
            self.fail("Expected duplicate ids to fail validation.")


class SubmissionLimitTests(unittest.TestCase):
    def test_cooldown_blocks_repeat_submission(self):
        with patched_backend_environment(submission_cooldown_minutes=5, submission_team_max_attempts=2):
            session = create_team("default-competition", "alice", "Alpha")
            now = datetime.now(timezone.utc)

            with get_connection() as connection:
                challenge_id = str(uuid4())
                connection.execute(
                    """
                    INSERT INTO submission_challenges (
                        id, user_id, team_id, competition_id, sample_indexes_json, used_at, expires_at, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        challenge_id,
                        session.user.id,
                        session.team.id,
                        session.competition.id,
                        "[0]",
                        (now + timedelta(minutes=10)).isoformat(),
                        now.isoformat(),
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO submission_results (
                        id, submission_id, user_id, team_id, competition_id,
                        accuracy, correct_count, sample_count, param_count, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid4()),
                        challenge_id,
                        session.user.id,
                        session.team.id,
                        session.competition.id,
                        0.5,
                        1,
                        2,
                        12,
                        now.isoformat(),
                    ),
                )
                connection.commit()

            with self.assertRaises(ValidationError) as exc_info:
                with get_connection() as connection:
                    _validate_submission_limits(
                        connection=connection,
                        competition_id=session.competition.id,
                        user_id=session.user.id,
                        team_id=session.team.id,
                        now=now,
                        submission_cooldown_minutes=5,
                        submission_limit=2,
                    )
            self.assertIn("once every 5 minutes", str(exc_info.exception))

    def test_submission_limit_blocks_when_team_is_at_capacity(self):
        with patched_backend_environment(submission_cooldown_minutes=0, submission_team_max_attempts=1):
            session = create_team("default-competition", "alice", "Alpha")
            now = datetime.now(timezone.utc)
            older = now - timedelta(seconds=1)

            with get_connection() as connection:
                challenge_id = str(uuid4())
                connection.execute(
                    """
                    INSERT INTO submission_challenges (
                        id, user_id, team_id, competition_id, sample_indexes_json, used_at, expires_at, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        challenge_id,
                        session.user.id,
                        session.team.id,
                        session.competition.id,
                        "[0]",
                        (now + timedelta(minutes=10)).isoformat(),
                        older.isoformat(),
                    ),
                )
                connection.execute(
                    """
                    INSERT INTO submission_results (
                        id, submission_id, user_id, team_id, competition_id,
                        accuracy, correct_count, sample_count, param_count, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid4()),
                        challenge_id,
                        session.user.id,
                        session.team.id,
                        session.competition.id,
                        0.5,
                        1,
                        2,
                        12,
                        older.isoformat(),
                    ),
                )
                connection.commit()

            with self.assertRaises(ValidationError) as exc_info:
                with get_connection() as connection:
                    _validate_submission_limits(
                        connection=connection,
                        competition_id=session.competition.id,
                        user_id=session.user.id,
                        team_id=session.team.id,
                        now=now,
                        submission_cooldown_minutes=0,
                        submission_limit=1,
                    )
            self.assertIn("submission limit of 1 attempts", str(exc_info.exception))
