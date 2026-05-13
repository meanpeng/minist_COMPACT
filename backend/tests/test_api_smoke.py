from __future__ import annotations

import base64
import json
import unittest
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services.competition_service import update_competition_settings
from backend.app.services import submission_service
from backend.tests.test_utils import patched_backend_environment


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
    "x8AAwMCAO2qfG0AAAAASUVORK5CYII="
)


class Stage1ApiSmokeTests(unittest.TestCase):
    def test_core_stage1_flows(self):
        fake_dataset = SimpleNamespace(
            images=tuple(bytes([index]) * 784 for index in range(10)),
            labels=tuple(range(10)),
        )

        with patched_backend_environment(submission_team_max_attempts=1, submission_cooldown_minutes=0) as settings:
            original_sample_count = submission_service.SUBMISSION_SAMPLE_COUNT
            original_get_dataset = submission_service._get_dataset
            submission_service.SUBMISSION_SAMPLE_COUNT = 5
            submission_service._DATASET_CACHE = {}
            submission_service._get_dataset = lambda test_dataset_source='mnist': fake_dataset
            try:
                with TestClient(app) as client:
                    create_resp = client.post(
                        "/api/auth/create-team",
                        json={
                            "competition_id": "default-competition",
                            "username": "alice",
                            "team_name": "Alpha Squad",
                        },
                    )
                    assert create_resp.status_code == 200, create_resp.text
                    create_data = create_resp.json()
                    token1 = create_data["session_token"]
                    invite_code = create_data["team"]["invite_code"]

                    join_resp = client.post(
                        "/api/auth/join-team",
                        json={
                            "competition_id": "default-competition",
                            "username": "bob",
                            "invite_code": invite_code,
                        },
                    )
                    assert join_resp.status_code == 200, join_resp.text
                    token2 = join_resp.json()["session_token"]

                    session_resp = client.get(
                        "/api/auth/session",
                        headers={"Authorization": f"Bearer {token2}"},
                    )
                    assert session_resp.status_code == 200, session_resp.text
                    assert session_resp.json()["user"]["username"] == "bob"

                    dashboard_resp = client.get(
                        "/api/dashboard",
                        headers={"Authorization": f"Bearer {token2}"},
                    )
                    assert dashboard_resp.status_code == 200, dashboard_resp.text
                    dashboard_data = dashboard_resp.json()
                    assert len(dashboard_data["team_members"]) == 2

                    submit_annotation_resp = client.post(
                        "/api/annotation/submit",
                        headers={"Authorization": f"Bearer {token1}"},
                        json={"label": 7, "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}"},
                    )
                    assert submit_annotation_resp.status_code == 200, submit_annotation_resp.text
                    assert submit_annotation_resp.json()["stats"]["counts_by_label"][7] == 1

                    stats_resp = client.get(
                        "/api/annotation/stats",
                        headers={"Authorization": f"Bearer {token1}"},
                    )
                    assert stats_resp.status_code == 200, stats_resp.text
                    assert stats_resp.json()["total_count"] == 1

                    model_resp = client.put(
                        "/api/modeling/config",
                        headers={"Authorization": f"Bearer {token1}"},
                        json={
                            "hidden_layers": [
                                {
                                    "id": "dense-1",
                                    "type": "dense",
                                    "units": 32,
                                    "activation": "relu",
                                },
                            ]
                        },
                    )
                    assert model_resp.status_code == 200, model_resp.text
                    assert model_resp.json()["summary"]["hidden_layer_count"] == 1

                    training_bootstrap_resp = client.get(
                        "/api/training/bootstrap",
                        headers={"Authorization": f"Bearer {token1}"},
                    )
                    assert training_bootstrap_resp.status_code == 200, training_bootstrap_resp.text
                    assert len(training_bootstrap_resp.json()["samples"]) == 1

                    submission_bootstrap_resp = client.get(
                        "/api/submission/bootstrap",
                        headers={"Authorization": f"Bearer {token1}"},
                    )
                    assert submission_bootstrap_resp.status_code == 200, submission_bootstrap_resp.text
                    submission_bootstrap_data = submission_bootstrap_resp.json()
                    assert submission_bootstrap_data["submission_available"] is True
                    assert submission_bootstrap_data["sample_count"] == 5

                    sample_indexes = [item["index"] for item in submission_bootstrap_data["challenge_images"]]
                    assert sample_indexes == list(range(5))
                    predictions = [
                        int(fake_dataset.labels[base64.b64decode(item["pixels_b64"])[0]])
                        for item in submission_bootstrap_data["challenge_images"]
                    ]

                    evaluate_resp = client.post(
                        "/api/submission/evaluate",
                        headers={"Authorization": f"Bearer {token1}"},
                        json={
                            "submission_id": submission_bootstrap_data["submission_id"],
                            "predictions": predictions,
                            "param_count": 1234,
                        },
                    )
                    assert evaluate_resp.status_code == 200, evaluate_resp.text
                    assert evaluate_resp.json()["accuracy"] == 1.0

                    blocked_bootstrap_resp = client.get(
                        "/api/submission/bootstrap",
                        headers={"Authorization": f"Bearer {token1}"},
                    )
                    assert blocked_bootstrap_resp.status_code == 200, blocked_bootstrap_resp.text
                    blocked_data = blocked_bootstrap_resp.json()
                    assert blocked_data["submission_available"] is False
                    assert "submission limit" in blocked_data["submission_block_reason"].lower()

                    log_path = settings.database_path.parent / "competition_logs" / "default-competition.log"
                    assert log_path.exists()
                    events = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
                    event_types = [event["event_type"] for event in events]
                    assert event_types == [
                        "team_created",
                        "user_created",
                        "user_created",
                        "team_joined",
                        "annotation_uploaded",
                        "model_saved",
                        "submission_evaluated",
                    ]
                    assert events[0]["team_name"] == "Alpha Squad"
                    assert events[4]["details"]["label"] == 7
                    assert events[5]["details"]["hidden_layers"][0]["type"] == "dense"
                    assert events[6]["details"]["accuracy"] == 1.0
            finally:
                submission_service.SUBMISSION_SAMPLE_COUNT = original_sample_count
                submission_service._get_dataset = original_get_dataset

    def test_local_test_dataset_flow(self):
        with patched_backend_environment(submission_team_max_attempts=1, submission_cooldown_minutes=0) as settings:
            submission_service._DATASET_CACHE = {}
            for label, file_name in ((0, "sample-0.png"), (1, "sample-1.png")):
                label_dir = settings.local_test_storage_path / str(label)
                label_dir.mkdir(parents=True, exist_ok=True)
                (label_dir / file_name).write_bytes(base64.b64decode(PNG_1X1_BASE64))

            update_competition_settings(
                competition_id="default-competition",
                competition_name="MNIST Classroom Challenge",
                end_time=None,
                manual_status=None,
                annotation_goal=3,
                team_member_limit=2,
                submission_limit=1,
                submission_cooldown_minutes=0,
                allow_submission=True,
                test_dataset_source="local_test",
            )

            with TestClient(app) as client:
                create_resp = client.post(
                    "/api/auth/create-team",
                    json={
                        "competition_id": "default-competition",
                        "username": "alice",
                        "team_name": "Alpha Squad",
                    },
                )
                assert create_resp.status_code == 200, create_resp.text
                token = create_resp.json()["session_token"]

                submission_resp = client.get(
                    "/api/submission/bootstrap",
                    headers={"Authorization": f"Bearer {token}"},
                )
                assert submission_resp.status_code == 200, submission_resp.text
                submission_data = submission_resp.json()
                assert submission_data["competition"]["test_dataset_source"] == "local_test"
                assert submission_data["sample_count"] == 2

                decoded_samples = [
                    base64.b64decode(item["pixels_b64"])
                    for item in submission_data["challenge_images"]
                ]
                assert [item["index"] for item in submission_data["challenge_images"]] == [0, 1]
                assert all(len(sample) == 28 * 28 for sample in decoded_samples)
                predictions = [0 for _ in submission_data["challenge_images"]]

                evaluate_resp = client.post(
                    "/api/submission/evaluate",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "submission_id": submission_data["submission_id"],
                        "predictions": predictions,
                        "param_count": 1234,
                    },
                )
                assert evaluate_resp.status_code == 200, evaluate_resp.text
                assert 0 <= evaluate_resp.json()["accuracy"] <= 1
