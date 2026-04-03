from __future__ import annotations

import argparse
import asyncio
import base64
import json
import time
from collections import Counter
from dataclasses import dataclass
from types import SimpleNamespace

import httpx

from backend.app.main import app
from backend.app.services import submission_service
from backend.tests.test_utils import patched_backend_environment


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/"
    "x8AAwMCAO2qfG0AAAAASUVORK5CYII="
)


@dataclass
class SoakMetrics:
    counts: Counter
    failures: list[str]

    def __init__(self) -> None:
        self.counts = Counter()
        self.failures = []

    def record(self, operation: str, status_code: int) -> None:
        self.counts[f"{operation}:{status_code}"] += 1

    def fail(self, operation: str, detail: str) -> None:
        self.failures.append(f"{operation}: {detail}")


async def _create_users(client: httpx.AsyncClient, user_count: int, metrics: SoakMetrics) -> list[str]:
    team_count = max(user_count // 2, 1)
    tokens: list[str] = []

    for team_index in range(team_count):
        create_response = await client.post(
            "/api/auth/create-team",
            json={
                "competition_id": "default-competition",
                "username": f"captain-{team_index}",
                "team_name": f"Soak Team {team_index}",
            },
        )
        metrics.record("create-team", create_response.status_code)
        if create_response.status_code != 200:
            metrics.fail("create-team", create_response.text)
            continue

        create_payload = create_response.json()
        invite_code = create_payload["team"]["invite_code"]
        leader_token = create_payload["session_token"]
        tokens.append(leader_token)

        annotation_response = await client.post(
            "/api/annotation/submit",
            headers={"Authorization": f"Bearer {leader_token}"},
            json={
                "label": team_index % 10,
                "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}",
            },
        )
        metrics.record("seed-annotation", annotation_response.status_code)
        if annotation_response.status_code != 200:
            metrics.fail("seed-annotation", annotation_response.text)
            continue

        model_response = await client.put(
            "/api/modeling/config",
            headers={"Authorization": f"Bearer {leader_token}"},
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
        metrics.record("seed-model", model_response.status_code)
        if model_response.status_code != 200:
            metrics.fail("seed-model", model_response.text)
            continue

        training_response = await client.put(
            "/api/training/run",
            headers={"Authorization": f"Bearer {leader_token}"},
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
        metrics.record("seed-training", training_response.status_code)
        if training_response.status_code != 200:
            metrics.fail("seed-training", training_response.text)
            continue

        join_response = await client.post(
            "/api/auth/join-team",
            json={
                "competition_id": "default-competition",
                "username": f"member-{team_index}",
                "invite_code": invite_code,
            },
        )
        metrics.record("join-team", join_response.status_code)
        if join_response.status_code == 200:
            tokens.append(join_response.json()["session_token"])
        else:
            metrics.fail("join-team", join_response.text)

    return tokens[:user_count]


async def _dashboard_loop(
    client: httpx.AsyncClient,
    token: str,
    metrics: SoakMetrics,
    stop_at: float,
) -> None:
    while time.monotonic() < stop_at:
        response = await client.get(
            "/api/dashboard",
            headers={"Authorization": f"Bearer {token}"},
        )
        metrics.record("dashboard", response.status_code)
        if response.status_code != 200:
            metrics.fail("dashboard", response.text)
        await asyncio.sleep(1)


async def _annotation_loop(
    client: httpx.AsyncClient,
    token: str,
    label: int,
    metrics: SoakMetrics,
    stop_at: float,
) -> None:
    while time.monotonic() < stop_at:
        response = await client.post(
            "/api/annotation/submit",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "label": label,
                "image_base64": f"data:image/png;base64,{PNG_1X1_BASE64}",
            },
        )
        metrics.record("annotation", response.status_code)
        if response.status_code != 200:
            metrics.fail("annotation", response.text)
        await asyncio.sleep(2)


async def _submission_loop(
    client: httpx.AsyncClient,
    token: str,
    labels_by_index: tuple[int, ...],
    metrics: SoakMetrics,
    stop_at: float,
) -> None:
    while time.monotonic() < stop_at:
        bootstrap_response = await client.get(
            "/api/submission/bootstrap",
            headers={"Authorization": f"Bearer {token}"},
        )
        metrics.record("submission-bootstrap", bootstrap_response.status_code)
        if bootstrap_response.status_code != 200:
            metrics.fail("submission-bootstrap", bootstrap_response.text)
            await asyncio.sleep(3)
            continue

        bootstrap_payload = bootstrap_response.json()
        if not bootstrap_payload["submission_available"]:
            await asyncio.sleep(3)
            continue

        predictions = []
        for image in bootstrap_payload["challenge_images"]:
            pixels = base64.b64decode(image["pixels_b64"])
            predictions.append(labels_by_index[pixels[0]])

        evaluate_response = await client.post(
            "/api/submission/evaluate",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "submission_id": bootstrap_payload["submission_id"],
                "predictions": predictions,
                "param_count": 2048,
            },
        )
        metrics.record("submission-evaluate", evaluate_response.status_code)
        if evaluate_response.status_code != 200:
            metrics.fail("submission-evaluate", evaluate_response.text)
        await asyncio.sleep(3)


async def _run_soak(duration_seconds: int, user_count: int) -> SoakMetrics:
    fake_dataset = SimpleNamespace(
        images=tuple(bytes([index]) * 784 for index in range(64)),
        labels=tuple(index % 10 for index in range(64)),
    )
    metrics = SoakMetrics()

    original_sample_count = submission_service.SUBMISSION_SAMPLE_COUNT
    original_get_dataset = submission_service._get_dataset
    submission_service.SUBMISSION_SAMPLE_COUNT = 8
    submission_service._DATASET_CACHE = None
    submission_service._get_dataset = lambda: fake_dataset

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            tokens = await _create_users(client, user_count, metrics)
            stop_at = time.monotonic() + duration_seconds

            tasks = []
            for index, token in enumerate(tokens):
                tasks.append(asyncio.create_task(_dashboard_loop(client, token, metrics, stop_at)))
                tasks.append(asyncio.create_task(_annotation_loop(client, token, index % 10, metrics, stop_at)))
                if index % 2 == 0:
                    tasks.append(
                        asyncio.create_task(
                            _submission_loop(client, token, fake_dataset.labels, metrics, stop_at)
                        )
                    )

            await asyncio.gather(*tasks)
    finally:
        submission_service.SUBMISSION_SAMPLE_COUNT = original_sample_count
        submission_service._get_dataset = original_get_dataset

    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage 3 classroom soak test runner")
    parser.add_argument("--duration-seconds", type=int, default=600)
    parser.add_argument("--users", type=int, default=50)
    args = parser.parse_args()

    with patched_backend_environment(
        team_member_limit=2,
        team_annotation_goal=3,
        submission_team_max_attempts=1000,
        submission_cooldown_minutes=0,
    ):
        started_at = time.monotonic()
        metrics = asyncio.run(_run_soak(args.duration_seconds, args.users))
        elapsed = round(time.monotonic() - started_at, 2)

    failure_count = len(metrics.failures)
    five_xx_count = sum(
        count
        for key, count in metrics.counts.items()
        if key.rsplit(":", 1)[-1].startswith("5")
    )

    summary = {
        "duration_seconds": args.duration_seconds,
        "users": args.users,
        "elapsed_seconds": elapsed,
        "metrics": dict(sorted(metrics.counts.items())),
        "failure_count": failure_count,
        "five_xx_count": five_xx_count,
        "sample_failures": metrics.failures[:10],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    return 1 if failure_count or five_xx_count else 0


if __name__ == "__main__":
    raise SystemExit(main())
