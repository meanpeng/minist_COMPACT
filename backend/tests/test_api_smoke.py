from __future__ import annotations

import base64
import unittest
from types import SimpleNamespace

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services import submission_service
from backend.tests.test_utils import patched_backend_environment


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
    "x8AAwMCAO2qfG0AAAAASUVORK5CYII="
)


class Stage1ApiSmokeTests(unittest.TestCase):
    def test_core_stage1_flows(self):
        fake_dataset = SimpleNamespace(
            images=tuple([b"\x00" * 784 for _ in range(10)]),
            labels=tuple(range(10)),
        )

        with patched_backend_environment(submission_team_max_attempts=1, submission_cooldown_minutes=0) as settings:
            original_sample_count = submission_service.SUBMISSION_SAMPLE_COUNT
            original_get_dataset = submission_service._get_dataset
            submission_service.SUBMISSION_SAMPLE_COUNT = 5
            submission_service._DATASET_CACHE = None
            submission_service._get_dataset = lambda: fake_dataset
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
                    predictions = [int(fake_dataset.labels[index]) for index in sample_indexes]

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
            finally:
                submission_service.SUBMISSION_SAMPLE_COUNT = original_sample_count
                submission_service._get_dataset = original_get_dataset
