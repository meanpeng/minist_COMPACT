from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import init_db
from .errors import AppError, UnauthorizedError
from .schemas import (
    AdminBootstrapResponse,
    AnnotationSubmitRequest,
    AnnotationSubmitResponse,
    CompetitionCreateRequest,
    CompetitionPayload,
    CompetitionSettingsUpdateRequest,
    CompetitionStatusPayload,
    DashboardResponse,
    ModelingConfigResponse,
    ModelingConfigUpdateRequest,
    SessionResponse,
    TeamAnnotationStatsResponse,
    TeamCreateRequest,
    TeamJoinRequest,
    SubmissionBootstrapResponse,
    SubmissionEvaluateRequest,
    SubmissionEvaluateResponse,
    TrainingBootstrapResponse,
    TrainingRunPayload,
    TrainingRunResponse,
)
from .services.admin_service import (
    create_admin_competition,
    delete_annotation,
    delete_member,
    delete_submission,
    delete_team,
    end_competition,
    get_admin_bootstrap,
    reset_team_invite_code,
    start_competition,
    update_admin_settings,
)
from .services.annotation_service import get_team_annotation_stats, submit_annotation
from .services.auth_service import create_team, get_session, join_team, list_competitions
from .services.dashboard_service import get_dashboard
from .services.modeling_service import get_model_config, save_model_config
from .services.submission_service import create_submission_bootstrap, evaluate_submission
from .services.training_service import get_training_bootstrap, save_training_run

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount(
    "/api/assets/annotations",
    StaticFiles(directory=settings.annotation_storage_path, check_dir=False),
    name="annotation-assets",
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()


@app.exception_handler(AppError)
async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "code": exc.code,
            "detail": exc.message,
        },
    )


@app.get("/health")
def health_check() -> Dict[str, str]:
    return {"status": "ok"}


def _extract_bearer_token(authorization: Optional[str]) -> str:
    if not authorization:
        raise UnauthorizedError("Authorization header is required.")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise UnauthorizedError("Authorization header must use Bearer token format.")

    return token.strip()


@app.post("/api/auth/create-team", response_model=SessionResponse)
def create_team_route(payload: TeamCreateRequest) -> SessionResponse:
    return create_team(payload.competition_id, payload.username, payload.team_name)


@app.post("/api/auth/join-team", response_model=SessionResponse)
def join_team_route(payload: TeamJoinRequest) -> SessionResponse:
    return join_team(payload.competition_id, payload.username, payload.invite_code)


@app.get("/api/competitions", response_model=List[CompetitionPayload])
def list_competitions_route() -> List[CompetitionPayload]:
    return list_competitions()


@app.get("/api/auth/session", response_model=SessionResponse)
def session_route(authorization: Optional[str] = Header(default=None)) -> SessionResponse:
    return get_session(_extract_bearer_token(authorization))


@app.get("/api/dashboard", response_model=DashboardResponse)
def dashboard_route(authorization: Optional[str] = Header(default=None)) -> DashboardResponse:
    return get_dashboard(_extract_bearer_token(authorization), settings.team_annotation_goal)


@app.post("/api/annotation/submit", response_model=AnnotationSubmitResponse)
def submit_annotation_route(
    payload: AnnotationSubmitRequest,
    authorization: Optional[str] = Header(default=None),
) -> AnnotationSubmitResponse:
    return submit_annotation(
        session_token=_extract_bearer_token(authorization),
        label=payload.label,
        image_base64=payload.image_base64,
    )


@app.get("/api/annotation/stats", response_model=TeamAnnotationStatsResponse)
def annotation_stats_route(authorization: Optional[str] = Header(default=None)) -> TeamAnnotationStatsResponse:
    return get_team_annotation_stats(_extract_bearer_token(authorization))


@app.get("/api/modeling/config", response_model=ModelingConfigResponse)
def get_modeling_config_route(authorization: Optional[str] = Header(default=None)) -> ModelingConfigResponse:
    return get_model_config(_extract_bearer_token(authorization))


@app.put("/api/modeling/config", response_model=ModelingConfigResponse)
def save_modeling_config_route(
    payload: ModelingConfigUpdateRequest,
    authorization: Optional[str] = Header(default=None),
) -> ModelingConfigResponse:
    return save_model_config(
        session_token=_extract_bearer_token(authorization),
        hidden_layers=payload.hidden_layers,
    )


@app.get("/api/training/bootstrap", response_model=TrainingBootstrapResponse)
def get_training_bootstrap_route(authorization: Optional[str] = Header(default=None)) -> TrainingBootstrapResponse:
    return get_training_bootstrap(_extract_bearer_token(authorization))


@app.put("/api/training/run", response_model=TrainingRunResponse)
def save_training_run_route(
    payload: TrainingRunPayload,
    authorization: Optional[str] = Header(default=None),
) -> TrainingRunResponse:
    return save_training_run(_extract_bearer_token(authorization), payload)


@app.get("/api/submission/bootstrap", response_model=SubmissionBootstrapResponse)
def get_submission_bootstrap_route(authorization: Optional[str] = Header(default=None)) -> SubmissionBootstrapResponse:
    return create_submission_bootstrap(_extract_bearer_token(authorization))


@app.post("/api/submission/evaluate", response_model=SubmissionEvaluateResponse)
def evaluate_submission_route(
    payload: SubmissionEvaluateRequest,
    authorization: Optional[str] = Header(default=None),
) -> SubmissionEvaluateResponse:
    return evaluate_submission(
        session_token=_extract_bearer_token(authorization),
        submission_id=payload.submission_id,
        predictions=payload.predictions,
        param_count=payload.param_count,
    )


@app.post("/api/admin/competitions", response_model=AdminBootstrapResponse)
def create_competition_route(payload: CompetitionCreateRequest) -> AdminBootstrapResponse:
    return create_admin_competition(payload.competition_name)


@app.get("/api/admin/bootstrap", response_model=AdminBootstrapResponse)
def admin_bootstrap_default_route() -> AdminBootstrapResponse:
    return get_admin_bootstrap()


@app.get("/api/admin/competitions/{competition_id}/bootstrap", response_model=AdminBootstrapResponse)
def admin_bootstrap_route(competition_id: str) -> AdminBootstrapResponse:
    return get_admin_bootstrap(competition_id)


@app.put("/api/admin/competitions/{competition_id}/settings", response_model=CompetitionStatusPayload)
def update_admin_settings_route(
    competition_id: str,
    payload: CompetitionSettingsUpdateRequest,
) -> CompetitionStatusPayload:
    return update_admin_settings(
        competition_id=competition_id,
        competition_name=payload.competition_name,
        start_time=payload.start_time,
        end_time=payload.end_time,
        manual_status=payload.manual_status,
        annotation_goal=payload.annotation_goal,
        submission_limit=payload.submission_limit,
        submission_cooldown_minutes=payload.submission_cooldown_minutes,
        allow_submission=payload.allow_submission,
    )


@app.post("/api/admin/competitions/{competition_id}/settings/start", response_model=CompetitionStatusPayload)
def start_competition_route(competition_id: str) -> CompetitionStatusPayload:
    return start_competition(competition_id)


@app.post("/api/admin/competitions/{competition_id}/settings/end", response_model=CompetitionStatusPayload)
def end_competition_route(competition_id: str) -> CompetitionStatusPayload:
    return end_competition(competition_id)


@app.post("/api/admin/competitions/{competition_id}/teams/{team_id}/reset-invite", response_model=AdminBootstrapResponse)
def reset_team_invite_route(competition_id: str, team_id: str) -> AdminBootstrapResponse:
    return reset_team_invite_code(competition_id, team_id)


@app.delete("/api/admin/competitions/{competition_id}/teams/{team_id}", response_model=AdminBootstrapResponse)
def delete_team_route(competition_id: str, team_id: str) -> AdminBootstrapResponse:
    return delete_team(competition_id, team_id)


@app.delete("/api/admin/competitions/{competition_id}/members/{user_id}", response_model=AdminBootstrapResponse)
def delete_member_route(competition_id: str, user_id: str) -> AdminBootstrapResponse:
    return delete_member(competition_id, user_id)


@app.delete("/api/admin/competitions/{competition_id}/annotations/{annotation_id}", response_model=AdminBootstrapResponse)
def delete_annotation_route(competition_id: str, annotation_id: str) -> AdminBootstrapResponse:
    return delete_annotation(competition_id, annotation_id)


@app.delete("/api/admin/competitions/{competition_id}/submissions/{submission_result_id}", response_model=AdminBootstrapResponse)
def delete_submission_route(competition_id: str, submission_result_id: str) -> AdminBootstrapResponse:
    return delete_submission(competition_id, submission_result_id)
