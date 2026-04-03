from __future__ import annotations

import asyncio
import base64
import unittest
from collections import Counter
from types import SimpleNamespace

import httpx

from backend.app.main import app
from backend.app.services import submission_service
from backend.tests.test_utils import patched_backend_environment


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
    "x8AAwMCAO2qfG0AAAAASUVORK5CYII="
)


class Stage3ConcurrencyAndStabilityTests(unittest.TestCase):
    def test_concurrent_join_team_caps_members_without_5xx(self):
        async def scenario() -> None:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                creator_response = await client.post(
                    "/api/auth/create-team",
                    json={
                        "competition_id": "default-competition",
                        "username": "captain",
                        "team_name": "Stress Alpha",
                    },
                )
                self.assertEqual(creator_response.status_code, 200, creator_response.text)
                invite_code = creator_response.json()["team"]["invite_code"]

                async def join_once(index: int) -> int:
                    response = await client.post(
                        "/api/auth/join-team",
                        json={
                            "competition_id": "default-competition",
                            "username": f"member-{index}",
                            "invite_code": invite_code,
                        },
                    )
                    return response.status_code

                status_codes = await asyncio.gather(*(join_once(index) for index in range(30)))
                counts = Counter(status_codes)

                self.assertEqual(counts.get(500, 0), 0, counts)
                self.assertEqual(counts.get(200, 0), 1, counts)
                self.assertEqual(counts.get(409, 0), 29, counts)

        with patched_backend_environment(team_member_limit=2):
            asyncio.run(scenario())

    def test_concurrent_dashboard_polling_and_annotation_submits_stay_consistent(self):
        async def scenario() -> None:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                team_tokens: list[str] = []
                for team_index in range(10):
                    leader_response = await client.post(
                        "/api/auth/create-team",
                        json={
                            "competition_id": "default-competition",
                            "username": f"leader-{team_index}",
                            "team_name": f"Team {team_index}",
                        },
                    )
                    self.assertEqual(leader_response.status_code, 200, leader_response.text)
                    leader_payload = leader_response.json()
                    invite_code = leader_payload["team"]["invite_code"]
                    team_tokens.append(leader_payload["session_token"])

                    for member_index in range(2):
                        join_response = await client.post(
                            "/api/auth/join-team",
                            json={
                                "competition_id": "default-competition",
                                "username": f"team-{team_index}-member-{member_index}",
                                "invite_code": invite_code,
                            },
                        )
                        self.assertEqual(join_response.status_code, 200, join_response.text)
                        team_tokens.append(join_response.json()["session_token"])

                async def poll_dashboard(token: str) -> int:
                    response = await client.get(
                        "/api/dashboard",
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    if response.status_code == 200:
                        payload = response.json()
                        self.assertIn("leaderboard", payload)
                        self.assertIn("annotation_stats", payload)
                        self.assertGreaterEqual(len(payload["team_members"]), 1)
                    return response.status_code

                async def submit_annotation(token: str, label: int) -> int:
                    response = await client.post(
                        "/api/annotation/submit",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "label": label,
                            "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}",
                        },
                    )
                    if response.status_code == 200:
                        stats = response.json()["stats"]
                        self.assertGreaterEqual(stats["total_count"], 1)
                    return response.status_code

                poll_status_codes = await asyncio.gather(
                    *(poll_dashboard(token) for _ in range(6) for token in team_tokens)
                )
                annotation_status_codes = await asyncio.gather(
                    *(submit_annotation(token, index % 10) for index, token in enumerate(team_tokens))
                )

                self.assertNotIn(500, poll_status_codes, Counter(poll_status_codes))
                self.assertNotIn(500, annotation_status_codes, Counter(annotation_status_codes))
                self.assertTrue(all(code == 200 for code in poll_status_codes), Counter(poll_status_codes))
                self.assertTrue(all(code == 200 for code in annotation_status_codes), Counter(annotation_status_codes))

                team_leader_token = team_tokens[0]
                stats_response = await client.get(
                    "/api/annotation/stats",
                    headers={"Authorization": f"Bearer {team_leader_token}"},
                )
                self.assertEqual(stats_response.status_code, 200, stats_response.text)
                self.assertEqual(stats_response.json()["total_count"], 3)

        with patched_backend_environment(team_member_limit=3, team_annotation_goal=3):
            asyncio.run(scenario())

    def test_concurrent_submission_bootstrap_and_evaluate_have_no_5xx(self):
        fake_dataset = SimpleNamespace(
            images=tuple(bytes([index]) * 784 for index in range(64)),
            labels=tuple(index % 10 for index in range(64)),
        )

        async def scenario() -> None:
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                tokens: list[str] = []
                for team_index in range(10):
                    create_response = await client.post(
                        "/api/auth/create-team",
                        json={
                            "competition_id": "default-competition",
                            "username": f"submitter-{team_index}",
                            "team_name": f"Submit Team {team_index}",
                        },
                    )
                    self.assertEqual(create_response.status_code, 200, create_response.text)
                    token = create_response.json()["session_token"]
                    tokens.append(token)

                    model_response = await client.put(
                        "/api/modeling/config",
                        headers={"Authorization": f"Bearer {token}"},
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
                    self.assertEqual(model_response.status_code, 200, model_response.text)

                    annotation_response = await client.post(
                        "/api/annotation/submit",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "label": team_index % 10,
                            "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}",
                        },
                    )
                    self.assertEqual(annotation_response.status_code, 200, annotation_response.text)

                    training_response = await client.put(
                        "/api/training/run",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "batch_size": 16,
                            "epochs": 2,
                            "learning_rate": 0.001,
                            "trained_sample_count": 1,
                            "augmentation_modes": [],
                            "augment_copies": 1,
                            "backend": "cpu",
                            "final_loss": 0.25,
                            "final_accuracy": 0.9,
                            "final_val_loss": 0.3,
                            "final_val_accuracy": 0.88,
                            "logs": [
                                {
                                    "epoch": 1,
                                    "loss": 0.4,
                                    "accuracy": 0.7,
                                    "val_loss": 0.45,
                                    "val_accuracy": 0.68,
                                },
                                {
                                    "epoch": 2,
                                    "loss": 0.25,
                                    "accuracy": 0.9,
                                    "val_loss": 0.3,
                                    "val_accuracy": 0.88,
                                },
                            ],
                        },
                    )
                    self.assertEqual(training_response.status_code, 200, training_response.text)

                async def bootstrap_and_submit(token: str) -> tuple[int, int]:
                    bootstrap_response = await client.get(
                        "/api/submission/bootstrap",
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    if bootstrap_response.status_code != 200:
                        return bootstrap_response.status_code, -1

                    bootstrap_payload = bootstrap_response.json()
                    prediction_values = []
                    for image in bootstrap_payload["challenge_images"]:
                        pixels = base64.b64decode(image["pixels_b64"])
                        prediction_values.append(fake_dataset.labels[pixels[0]])

                    evaluate_response = await client.post(
                        "/api/submission/evaluate",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "submission_id": bootstrap_payload["submission_id"],
                            "predictions": prediction_values,
                            "param_count": 2048,
                        },
                    )
                    return bootstrap_response.status_code, evaluate_response.status_code

                result_pairs = await asyncio.gather(*(bootstrap_and_submit(token) for token in tokens))
                bootstrap_codes = [bootstrap_code for bootstrap_code, _ in result_pairs]
                evaluate_codes = [evaluate_code for _, evaluate_code in result_pairs]

                self.assertNotIn(500, bootstrap_codes, Counter(bootstrap_codes))
                self.assertNotIn(500, evaluate_codes, Counter(evaluate_codes))
                self.assertTrue(all(code == 200 for code in bootstrap_codes), Counter(bootstrap_codes))
                self.assertTrue(all(code == 200 for code in evaluate_codes), Counter(evaluate_codes))

        with patched_backend_environment(
            submission_team_max_attempts=2,
            submission_cooldown_minutes=0,
        ):
            original_sample_count = submission_service.SUBMISSION_SAMPLE_COUNT
            original_get_dataset = submission_service._get_dataset
            submission_service.SUBMISSION_SAMPLE_COUNT = 8
            submission_service._DATASET_CACHE = None
            submission_service._get_dataset = lambda: fake_dataset
            try:
                asyncio.run(scenario())
            finally:
                submission_service.SUBMISSION_SAMPLE_COUNT = original_sample_count
                submission_service._get_dataset = original_get_dataset
