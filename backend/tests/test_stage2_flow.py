from __future__ import annotations

from types import SimpleNamespace
import unittest

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services import submission_service
from backend.tests.test_utils import patched_backend_environment


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
    "x8AAwMCAO2qfG0AAAAASUVORK5CYII="
)


class Stage2MainFlowIntegrationTests(unittest.TestCase):
    def test_complete_competition_flow_syncs_training_submission_and_dashboard(self):
        fake_dataset = SimpleNamespace(
            images=tuple([bytes([index]) * 784 for index in range(10)]),
            labels=tuple(range(10)),
        )

        with patched_backend_environment(
            team_annotation_goal=3,
            submission_team_max_attempts=3,
            submission_cooldown_minutes=0,
        ):
            original_sample_count = submission_service.SUBMISSION_SAMPLE_COUNT
            original_get_dataset = submission_service._get_dataset
            submission_service.SUBMISSION_SAMPLE_COUNT = 5
            submission_service._DATASET_CACHE = None
            submission_service._get_dataset = lambda: fake_dataset
            try:
                with TestClient(app) as client:
                    alice_session = client.post(
                        "/api/auth/create-team",
                        json={
                            "competition_id": "default-competition",
                            "username": "alice",
                            "team_name": "Alpha Squad",
                        },
                    ).json()
                    alice_token = alice_session["session_token"]

                    bob_session = client.post(
                        "/api/auth/join-team",
                        json={
                            "competition_id": "default-competition",
                            "username": "bob",
                            "invite_code": alice_session["team"]["invite_code"],
                        },
                    ).json()
                    bob_token = bob_session["session_token"]

                    beta_session = client.post(
                        "/api/auth/create-team",
                        json={
                            "competition_id": "default-competition",
                            "username": "carol",
                            "team_name": "Beta Squad",
                        },
                    ).json()
                    beta_token = beta_session["session_token"]

                    for label in (1, 2, 3):
                        annotation_resp = client.post(
                            "/api/annotation/submit",
                            headers={"Authorization": f"Bearer {alice_token}"},
                            json={"label": label, "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}"},
                        )
                        assert annotation_resp.status_code == 200, annotation_resp.text

                    dashboard_before_training = client.get(
                        "/api/dashboard",
                        headers={"Authorization": f"Bearer {bob_token}"},
                    )
                    assert dashboard_before_training.status_code == 200, dashboard_before_training.text
                    dashboard_before_training_data = dashboard_before_training.json()
                    assert len(dashboard_before_training_data["team_members"]) == 2
                    assert dashboard_before_training_data["annotation_stats"]["total_count"] == 3
                    assert dashboard_before_training_data["annotation_stats"]["remaining_to_goal"] == 0

                    model_resp = client.put(
                        "/api/modeling/config",
                        headers={"Authorization": f"Bearer {alice_token}"},
                        json={
                            "hidden_layers": [
                                {
                                    "id": "dense-1",
                                    "type": "dense",
                                    "units": 32,
                                    "activation": "relu",
                                }
                            ]
                        },
                    )
                    assert model_resp.status_code == 200, model_resp.text

                    training_bootstrap = client.get(
                        "/api/training/bootstrap",
                        headers={"Authorization": f"Bearer {alice_token}"},
                    )
                    assert training_bootstrap.status_code == 200, training_bootstrap.text
                    training_bootstrap_data = training_bootstrap.json()
                    assert len(training_bootstrap_data["samples"]) == 3
                    assert training_bootstrap_data["latest_run"] is None

                    training_run_resp = client.put(
                        "/api/training/run",
                        headers={"Authorization": f"Bearer {alice_token}"},
                        json={
                            "batch_size": 16,
                            "epochs": 3,
                            "learning_rate": 0.001,
                            "trained_sample_count": 3,
                            "augmentation_modes": ["shift"],
                            "augment_copies": 2,
                            "backend": "cpu",
                            "final_loss": 0.12,
                            "final_accuracy": 0.97,
                            "final_val_loss": 0.18,
                            "final_val_accuracy": 0.93,
                            "logs": [
                                {
                                    "epoch": 1,
                                    "loss": 0.34,
                                    "accuracy": 0.66,
                                    "val_loss": 0.41,
                                    "val_accuracy": 0.61,
                                },
                                {
                                    "epoch": 2,
                                    "loss": 0.21,
                                    "accuracy": 0.84,
                                    "val_loss": 0.27,
                                    "val_accuracy": 0.79,
                                },
                                {
                                    "epoch": 3,
                                    "loss": 0.12,
                                    "accuracy": 0.97,
                                    "val_loss": 0.18,
                                    "val_accuracy": 0.93,
                                },
                            ],
                        },
                    )
                    assert training_run_resp.status_code == 200, training_run_resp.text
                    assert training_run_resp.json()["final_accuracy"] == 0.97

                    submission_bootstrap_alpha = client.get(
                        "/api/submission/bootstrap",
                        headers={"Authorization": f"Bearer {alice_token}"},
                    )
                    assert submission_bootstrap_alpha.status_code == 200, submission_bootstrap_alpha.text
                    alpha_bootstrap_data = submission_bootstrap_alpha.json()
                    assert alpha_bootstrap_data["submission_available"] is True
                    assert alpha_bootstrap_data["latest_run"]["epochs"] == 3
                    assert alpha_bootstrap_data["remaining_team_attempts"] == 3
                    assert len(alpha_bootstrap_data["challenge_images"]) == 5

                    alpha_predictions = [
                        int(fake_dataset.labels[item["index"]])
                        for item in alpha_bootstrap_data["challenge_images"]
                    ]
                    alpha_evaluate = client.post(
                        "/api/submission/evaluate",
                        headers={"Authorization": f"Bearer {alice_token}"},
                        json={
                            "submission_id": alpha_bootstrap_data["submission_id"],
                            "predictions": alpha_predictions,
                            "param_count": 3210,
                        },
                    )
                    assert alpha_evaluate.status_code == 200, alpha_evaluate.text
                    alpha_evaluate_data = alpha_evaluate.json()
                    assert alpha_evaluate_data["accuracy"] == 1.0
                    assert alpha_evaluate_data["rank"] == 1
                    assert alpha_evaluate_data["remaining_team_attempts"] == 2

                    client.put(
                        "/api/modeling/config",
                        headers={"Authorization": f"Bearer {beta_token}"},
                        json={
                            "hidden_layers": [
                                {
                                    "id": "dense-1",
                                    "type": "dense",
                                    "units": 32,
                                    "activation": "relu",
                                }
                            ]
                        },
                    )

                    submission_bootstrap_beta = client.get(
                        "/api/submission/bootstrap",
                        headers={"Authorization": f"Bearer {beta_token}"},
                    )
                    assert submission_bootstrap_beta.status_code == 200, submission_bootstrap_beta.text
                    beta_bootstrap_data = submission_bootstrap_beta.json()
                    beta_predictions = [
                        (int(fake_dataset.labels[item["index"]]) + (1 if index == 0 else 0)) % 10
                        for index, item in enumerate(beta_bootstrap_data["challenge_images"])
                    ]
                    beta_evaluate = client.post(
                        "/api/submission/evaluate",
                        headers={"Authorization": f"Bearer {beta_token}"},
                        json={
                            "submission_id": beta_bootstrap_data["submission_id"],
                            "predictions": beta_predictions,
                            "param_count": 4000,
                        },
                    )
                    assert beta_evaluate.status_code == 200, beta_evaluate.text
                    beta_evaluate_data = beta_evaluate.json()
                    assert beta_evaluate_data["rank"] == 2
                    assert beta_evaluate_data["accuracy"] < 1.0

                    dashboard_after_submit = client.get(
                        "/api/dashboard",
                        headers={"Authorization": f"Bearer {alice_token}"},
                    )
                    assert dashboard_after_submit.status_code == 200, dashboard_after_submit.text
                    dashboard_data = dashboard_after_submit.json()
                    assert dashboard_data["ranking"]["rank"] == 1
                    assert dashboard_data["ranking"]["total_ranked_teams"] == 2
                    assert dashboard_data["latest_validation"]["latest_accuracy"] == 1.0
                    assert dashboard_data["latest_validation"]["submitted_by"] == "alice"
                    assert dashboard_data["leaderboard"][0]["team_name"] == "Alpha Squad"
                    assert dashboard_data["leaderboard"][0]["is_current_team"] is True
                    assert dashboard_data["leaderboard"][1]["team_name"] == "Beta Squad"
            finally:
                submission_service.SUBMISSION_SAMPLE_COUNT = original_sample_count
                submission_service._get_dataset = original_get_dataset
