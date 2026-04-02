from __future__ import annotations

import json
from datetime import datetime, timezone
from math import ceil, floor
from typing import Iterable, List, Optional

from ..database import get_connection
from ..errors import NotFoundError, ValidationError
from ..schemas import ModelLayerPayload, ModelingConfigResponse, ModelSummaryPayload
from .auth_service import get_authenticated_user

INPUT_HEIGHT = 28
INPUT_WIDTH = 28
INPUT_CHANNELS = 1
OUTPUT_CLASSES = 10
MAX_PARAM_COUNT = 200_000

CONV_FILTER_OPTIONS = {8, 16, 32, 64}
CONV_KERNEL_OPTIONS = {3, 5}
CONV_ACTIVATIONS = {"relu", "tanh"}
CONV_PADDING_OPTIONS = {"same", "valid"}
POOL_SIZE_OPTIONS = {2, 3}
POOL_STRIDE_OPTIONS = {1, 2}
DROPOUT_RATE_OPTIONS = {0.1, 0.2, 0.25, 0.3, 0.5}
DENSE_UNIT_OPTIONS = {32, 64, 128, 256}
DENSE_ACTIVATIONS = {"relu", "tanh", "sigmoid"}


def _layer_to_dict(layer: ModelLayerPayload) -> dict:
    if hasattr(layer, "model_dump"):
        return layer.model_dump()
    return layer.dict()


def _ensure_team_membership(user_id: str, team_id: str) -> None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT 1
            FROM users
            WHERE id = ? AND team_id = ?
            """,
            (user_id, team_id),
        ).fetchone()
        if not row:
            raise NotFoundError("User was not found in the requested team.")


def _ensure_team_exists(team_id: str) -> None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT 1
            FROM teams
            WHERE id = ?
            """,
            (team_id,),
        ).fetchone()
        if not row:
            raise NotFoundError("Team was not found.")


def _same_padding_size(size: int, stride: int) -> int:
    return max(ceil(size / stride), 1)


def _valid_padding_size(size: int, kernel: int, stride: int) -> int:
    return max(floor((size - kernel) / stride) + 1, 1)


def _normalize_layer(layer: ModelLayerPayload) -> ModelLayerPayload:
    layer_type = layer.type.strip().lower()
    if layer_type not in {"conv2d", "maxpool", "dropout", "dense"}:
        raise ValidationError(f"Unsupported layer type: {layer.type}.")

    if layer_type == "conv2d":
        if layer.filters not in CONV_FILTER_OPTIONS:
            raise ValidationError("Conv2D filters must be selected from the preset options.")
        if layer.kernel_size not in CONV_KERNEL_OPTIONS:
            raise ValidationError("Conv2D kernel size must be selected from the preset options.")
        activation = (layer.activation or "relu").lower()
        padding = (layer.padding or "same").lower()
        if activation not in CONV_ACTIVATIONS:
            raise ValidationError("Conv2D activation must be selected from the preset options.")
        if padding not in CONV_PADDING_OPTIONS:
            raise ValidationError("Conv2D padding must be selected from the preset options.")
        return (
            ModelLayerPayload(
                id=layer.id,
                type="conv2d",
                filters=layer.filters,
                kernel_size=layer.kernel_size,
                activation=activation,
                padding=padding,
            )
        )

    if layer_type == "maxpool":
        if layer.pool_size not in POOL_SIZE_OPTIONS:
            raise ValidationError("Pooling size must be selected from the preset options.")
        if layer.strides not in POOL_STRIDE_OPTIONS:
            raise ValidationError("Pooling stride must be selected from the preset options.")
        return (
            ModelLayerPayload(
                id=layer.id,
                type="maxpool",
                pool_size=layer.pool_size,
                strides=layer.strides,
            )
        )

    if layer_type == "dropout":
        if layer.rate not in DROPOUT_RATE_OPTIONS:
            raise ValidationError("Dropout rate must be selected from the preset options.")
        return (
            ModelLayerPayload(
                id=layer.id,
                type="dropout",
                rate=layer.rate,
            )
        )

    if layer.units not in DENSE_UNIT_OPTIONS:
        raise ValidationError("Dense units must be selected from the preset options.")
    activation = (layer.activation or "relu").lower()
    if activation not in DENSE_ACTIVATIONS:
        raise ValidationError("Dense activation must be selected from the preset options.")
    return (
        ModelLayerPayload(
            id=layer.id,
            type="dense",
            units=layer.units,
            activation=activation,
        )
    )


def _normalize_layers(hidden_layers: Iterable[ModelLayerPayload]) -> List[ModelLayerPayload]:
    normalized: List[ModelLayerPayload] = []
    seen_ids = set()

    for layer in hidden_layers:
        if layer.id in seen_ids:
            raise ValidationError("Layer ids must be unique.")
        seen_ids.add(layer.id)
        normalized.append(_normalize_layer(layer))

    return normalized


def _ordered_layers_for_execution(hidden_layers: List[ModelLayerPayload]) -> List[ModelLayerPayload]:
    feature_layers: List[ModelLayerPayload] = []
    head_layers: List[ModelLayerPayload] = []
    for layer in hidden_layers:
        if layer.type in {"conv2d", "maxpool"}:
            feature_layers.append(layer)
        else:
            head_layers.append(layer)
    return feature_layers + head_layers


def _build_summary(hidden_layers: List[ModelLayerPayload]) -> ModelSummaryPayload:
    execution_layers = _ordered_layers_for_execution(hidden_layers)
    height = INPUT_HEIGHT
    width = INPUT_WIDTH
    channels = INPUT_CHANNELS
    flattened_features = None
    total_params = 0
    dense_started = False

    for layer in execution_layers:
        if layer.type == "conv2d":
            kernel = int(layer.kernel_size)
            filters = int(layer.filters)
            total_params += (kernel * kernel * channels + 1) * filters
            if layer.padding == "same":
                height = _same_padding_size(height, 1)
                width = _same_padding_size(width, 1)
            else:
                height = _valid_padding_size(height, kernel, 1)
                width = _valid_padding_size(width, kernel, 1)
            channels = filters
            continue

        if layer.type == "maxpool":
            pool_size = int(layer.pool_size)
            stride = int(layer.strides)
            height = _valid_padding_size(height, pool_size, stride)
            width = _valid_padding_size(width, pool_size, stride)
            continue

        if layer.type == "dropout":
            continue

        if not dense_started:
            flattened_features = height * width * channels
            dense_started = True

        units = int(layer.units)
        total_params += ((flattened_features or 0) + 1) * units
        flattened_features = units

    if flattened_features is None:
        flattened_features = height * width * channels
        flatten_position = "before_output"
    else:
        flatten_position = "before_first_dense"

    total_params += (flattened_features + 1) * OUTPUT_CLASSES
    if total_params > MAX_PARAM_COUNT:
        raise ValidationError(f"Model parameter count exceeds the {MAX_PARAM_COUNT} limit.")

    estimated_memory_mb = round((total_params * 4) / (1024 * 1024), 2)
    estimated_compute = f"{max(total_params / 1_000_000, 0.01):.2f} M-ops"

    return ModelSummaryPayload(
        hidden_layer_count=len(hidden_layers),
        param_count=total_params,
        estimated_memory_mb=estimated_memory_mb,
        estimated_compute=estimated_compute,
        flatten_position=flatten_position,
        output_classes=OUTPUT_CLASSES,
    )


def _serialize_response(
    *,
    user_id: str,
    team_id: str,
    competition_id: str,
    hidden_layers: List[ModelLayerPayload],
    updated_at: Optional[str],
) -> ModelingConfigResponse:
    return ModelingConfigResponse(
        user_id=user_id,
        team_id=team_id,
        competition_id=competition_id,
        hidden_layers=hidden_layers,
        summary=_build_summary(hidden_layers),
        updated_at=updated_at,
    )


def get_model_config(session_token: str) -> ModelingConfigResponse:
    auth = get_authenticated_user(session_token)
    user_id = auth["user_id"]

    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT user_id, team_id, competition_id, config_json, updated_at
            FROM user_model_configs
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

    if not row:
        with get_connection() as connection:
            membership = connection.execute(
                """
                SELECT id AS user_id, team_id, competition_id
                FROM users
                WHERE id = ?
                """,
                (user_id,),
            ).fetchone()
        if not membership:
            raise NotFoundError("User was not found.")
        return _serialize_response(
            user_id=membership["user_id"],
            team_id=membership["team_id"],
            competition_id=membership["competition_id"],
            hidden_layers=[],
            updated_at=None,
        )

    hidden_layers = _normalize_layers(
        ModelLayerPayload(**layer_payload) for layer_payload in json.loads(row["config_json"])
    )
    return _serialize_response(
        user_id=row["user_id"],
        team_id=row["team_id"],
        competition_id=row["competition_id"],
        hidden_layers=hidden_layers,
        updated_at=row["updated_at"],
    )


def save_model_config(*, session_token: str, hidden_layers: List[ModelLayerPayload]) -> ModelingConfigResponse:
    auth = get_authenticated_user(session_token)
    user_id = auth["user_id"]
    team_id = auth["team_id"]
    competition_id = auth["competition_id"]
    _ensure_team_membership(user_id, team_id)
    normalized_layers = _normalize_layers(hidden_layers)
    summary = _build_summary(normalized_layers)
    updated_at = datetime.now(timezone.utc).isoformat()
    config_json = json.dumps([_layer_to_dict(layer) for layer in normalized_layers])

    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO user_model_configs (user_id, team_id, competition_id, config_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                team_id = excluded.team_id,
                competition_id = excluded.competition_id,
                config_json = excluded.config_json,
                updated_at = excluded.updated_at
            """,
            (user_id, team_id, competition_id, config_json, updated_at),
        )
        connection.commit()

    return ModelingConfigResponse(
        user_id=user_id,
        team_id=team_id,
        competition_id=competition_id,
        hidden_layers=normalized_layers,
        summary=summary,
        updated_at=updated_at,
    )
