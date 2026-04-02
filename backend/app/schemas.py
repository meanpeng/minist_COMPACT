from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class TeamCreateRequest(BaseModel):
    competition_id: str = Field(min_length=1)
    username: str = Field(min_length=1, max_length=32)
    team_name: str = Field(min_length=1, max_length=64)


class TeamJoinRequest(BaseModel):
    competition_id: str = Field(min_length=1)
    username: str = Field(min_length=1, max_length=32)
    invite_code: str = Field(min_length=1, max_length=64)


class CompetitionPayload(BaseModel):
    id: str
    name: str
    created_at: str


class AdminCompetitionListItemPayload(BaseModel):
    id: str
    name: str
    created_at: str
    effective_status: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    is_selected: bool = False


class UserPayload(BaseModel):
    id: str
    username: str


class TeamPayload(BaseModel):
    id: str
    name: str
    invite_code: str


class SessionResponse(BaseModel):
    session_token: str
    expires_at: str
    competition: CompetitionPayload
    user: UserPayload
    team: TeamPayload


class CompetitionStatusPayload(BaseModel):
    competition_id: str
    competition_name: str
    effective_status: str
    manual_status: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    current_time: str
    seconds_until_start: Optional[int] = None
    seconds_until_end: Optional[int] = None
    annotation_goal: int = Field(ge=0)
    submission_limit: int = Field(ge=1)
    submission_cooldown_minutes: int = Field(ge=0)
    allow_submission: bool
    is_submission_open: bool


class DashboardRankingPayload(BaseModel):
    rank: Optional[int] = None
    total_ranked_teams: int = Field(ge=0)
    percentile: Optional[float] = Field(default=None, ge=0, le=1)


class DashboardLatestValidationPayload(BaseModel):
    latest_accuracy: Optional[float] = Field(default=None, ge=0, le=1)
    previous_best_accuracy: Optional[float] = Field(default=None, ge=0, le=1)
    submitted_at: Optional[str] = None
    submitted_by: Optional[str] = None
    sample_count: Optional[int] = Field(default=None, ge=1)


class DashboardLeaderboardEntryPayload(BaseModel):
    rank: int = Field(ge=1)
    team_id: str
    team_name: str
    member_names: List[str] = Field(default_factory=list)
    accuracy: float = Field(ge=0, le=1)
    status: str
    submitted_by: str
    created_at: str
    is_current_team: bool = False


class DashboardResponse(BaseModel):
    session: SessionResponse
    competition: CompetitionStatusPayload
    team_members: List[UserPayload] = Field(default_factory=list)
    annotation_stats: "TeamAnnotationStatsResponse"
    ranking: DashboardRankingPayload
    latest_validation: DashboardLatestValidationPayload
    leaderboard: List[DashboardLeaderboardEntryPayload] = Field(default_factory=list)


class AnnotationSubmitRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    label: int = Field(ge=0, le=9)


class AnnotationSamplePayload(BaseModel):
    id: str
    label: int
    created_at: str
    image_path: str


class TeamAnnotationStatsResponse(BaseModel):
    team_id: str
    total_count: int
    goal: int
    remaining_to_goal: int
    progress_ratio: float
    counts_by_label: List[int]


class AnnotationSubmitResponse(BaseModel):
    status: str
    sample: AnnotationSamplePayload
    stats: TeamAnnotationStatsResponse


class ModelLayerPayload(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    type: str = Field(min_length=1, max_length=32)
    filters: Optional[int] = Field(default=None, ge=1)
    kernel_size: Optional[int] = Field(default=None, ge=1)
    activation: Optional[str] = Field(default=None, min_length=1, max_length=32)
    padding: Optional[str] = Field(default=None, min_length=1, max_length=16)
    pool_size: Optional[int] = Field(default=None, ge=1)
    strides: Optional[int] = Field(default=None, ge=1)
    rate: Optional[float] = Field(default=None, ge=0, le=1)
    units: Optional[int] = Field(default=None, ge=1)


class ModelSummaryPayload(BaseModel):
    hidden_layer_count: int
    param_count: int
    estimated_memory_mb: float
    estimated_compute: str
    flatten_position: str
    output_classes: int


class ModelingConfigResponse(BaseModel):
    user_id: str
    team_id: str
    competition_id: str
    hidden_layers: List[ModelLayerPayload]
    summary: ModelSummaryPayload
    updated_at: Optional[str] = None


class ModelingConfigUpdateRequest(BaseModel):
    hidden_layers: List[ModelLayerPayload] = Field(default_factory=list)


class TrainingSamplePayload(BaseModel):
    id: str
    label: int
    created_at: str
    image_url: str = Field(min_length=1)


class TrainingRunMetricPoint(BaseModel):
    epoch: int = Field(ge=1)
    loss: float = Field(ge=0)
    accuracy: float = Field(ge=0, le=1)
    val_loss: Optional[float] = Field(default=None, ge=0)
    val_accuracy: Optional[float] = Field(default=None, ge=0, le=1)


class TrainingRunPayload(BaseModel):
    batch_size: int = Field(ge=1, le=512)
    epochs: int = Field(ge=1, le=200)
    learning_rate: float = Field(gt=0, le=1)
    trained_sample_count: int = Field(ge=1)
    augmentation_modes: List[str] = Field(default_factory=list)
    augment_copies: int = Field(default=1, ge=1, le=8)
    backend: str = Field(min_length=1, max_length=32)
    final_loss: Optional[float] = Field(default=None, ge=0)
    final_accuracy: Optional[float] = Field(default=None, ge=0, le=1)
    final_val_loss: Optional[float] = Field(default=None, ge=0)
    final_val_accuracy: Optional[float] = Field(default=None, ge=0, le=1)
    logs: List[TrainingRunMetricPoint] = Field(default_factory=list)


class TrainingRunResponse(BaseModel):
    user_id: str
    team_id: str
    competition_id: str
    batch_size: int
    epochs: int
    learning_rate: float
    trained_sample_count: int
    augmentation_modes: List[str] = Field(default_factory=list)
    augment_copies: int = 1
    backend: str
    final_loss: Optional[float] = None
    final_accuracy: Optional[float] = None
    final_val_loss: Optional[float] = None
    final_val_accuracy: Optional[float] = None
    logs: List[TrainingRunMetricPoint] = Field(default_factory=list)
    created_at: str
    updated_at: str


class TrainingBootstrapResponse(BaseModel):
    user_id: str
    team_id: str
    competition_id: str
    samples: List[TrainingSamplePayload]
    modeling_config: ModelingConfigResponse
    latest_run: Optional[TrainingRunResponse] = None


class SubmissionChallengeImagePayload(BaseModel):
    index: int = Field(ge=0)
    pixels_b64: str = Field(min_length=1)


class SubmissionScorePayload(BaseModel):
    accuracy: float = Field(ge=0, le=1)
    param_count: int = Field(ge=0)
    team_id: str
    team_name: str
    submitted_by: str
    created_at: str


class SubmissionBootstrapResponse(BaseModel):
    submission_id: Optional[str] = None
    user_id: str
    team_id: str
    sample_count: int = Field(ge=0)
    competition: CompetitionStatusPayload
    team_submission_limit: int = Field(ge=1)
    remaining_team_attempts: int = Field(ge=0)
    submission_available: bool = True
    submission_block_reason: Optional[str] = None
    challenge_images: List[SubmissionChallengeImagePayload] = Field(default_factory=list)
    modeling_config: ModelingConfigResponse
    latest_run: Optional[TrainingRunResponse] = None
    latest_result: Optional[SubmissionScorePayload] = None
    leaderboard: List[SubmissionScorePayload] = Field(default_factory=list)


class SubmissionEvaluateRequest(BaseModel):
    submission_id: str = Field(min_length=1)
    predictions: List[int] = Field(min_length=1)
    param_count: int = Field(ge=0)


class SubmissionEvaluateResponse(BaseModel):
    competition: CompetitionStatusPayload
    accuracy: float = Field(ge=0, le=1)
    correct_count: int = Field(ge=0)
    sample_count: int = Field(ge=1)
    rank: int = Field(ge=1)
    team_submission_limit: int = Field(ge=1)
    remaining_team_attempts: int = Field(ge=0)
    leaderboard: List[SubmissionScorePayload] = Field(default_factory=list)
    latest_result: SubmissionScorePayload


class CompetitionSettingsUpdateRequest(BaseModel):
    competition_name: str = Field(min_length=1, max_length=128)
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    manual_status: Optional[str] = None
    annotation_goal: int = Field(ge=0, le=100000)
    submission_limit: int = Field(ge=1, le=1000)
    submission_cooldown_minutes: int = Field(ge=0, le=1440)
    allow_submission: bool


class CompetitionCreateRequest(BaseModel):
    competition_name: str = Field(min_length=1, max_length=128)


class AdminOverviewPayload(BaseModel):
    competition: CompetitionStatusPayload
    team_count: int = Field(ge=0)
    member_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)
    qualified_team_count: int = Field(ge=0)
    submitted_team_count: int = Field(ge=0)
    current_leader: Optional[SubmissionScorePayload] = None
    recent_submissions: List["AdminSubmissionPayload"] = Field(default_factory=list)


class AdminTeamPayload(BaseModel):
    id: str
    name: str
    invite_code: str
    created_at: str
    member_count: int = Field(ge=0)
    annotation_count: int = Field(ge=0)
    remaining_to_goal: int = Field(ge=0)
    counts_by_label: List[int] = Field(default_factory=list)
    has_reached_goal: bool
    submission_count: int = Field(ge=0)
    remaining_submission_attempts: int = Field(ge=0)
    best_accuracy: Optional[float] = Field(default=None, ge=0, le=1)
    best_param_count: Optional[int] = Field(default=None, ge=0)
    best_submitted_at: Optional[str] = None
    best_submitted_by: Optional[str] = None


class AdminMemberPayload(BaseModel):
    id: str
    username: str
    team_id: str
    team_name: str
    created_at: str
    annotation_count: int = Field(ge=0)
    submission_count: int = Field(ge=0)


class AdminMemberContributionPayload(BaseModel):
    user_id: str
    username: str
    annotation_count: int = Field(ge=0)


class AdminAnnotationSamplePayload(BaseModel):
    id: str
    team_id: str
    team_name: str
    user_id: str
    username: str
    label: int = Field(ge=0, le=9)
    image_url: str
    created_at: str


class AdminSubmissionPayload(BaseModel):
    id: str
    submission_id: str
    team_id: str
    team_name: str
    user_id: str
    username: str
    accuracy: float = Field(ge=0, le=1)
    correct_count: int = Field(ge=0)
    sample_count: int = Field(ge=1)
    param_count: int = Field(ge=0)
    created_at: str


class AdminLeaderboardEntryPayload(BaseModel):
    rank: int = Field(ge=1)
    team_id: str
    team_name: str
    accuracy: float = Field(ge=0, le=1)
    param_count: int = Field(ge=0)
    submitted_by: str
    created_at: str
    submission_count: int = Field(ge=0)


class AdminTeamDetailPayload(BaseModel):
    team_id: str
    member_contributions: List[AdminMemberContributionPayload] = Field(default_factory=list)


class AdminBootstrapResponse(BaseModel):
    competitions: List[AdminCompetitionListItemPayload] = Field(default_factory=list)
    selected_competition_id: Optional[str] = None
    settings: CompetitionStatusPayload
    overview: AdminOverviewPayload
    teams: List[AdminTeamPayload] = Field(default_factory=list)
    members: List[AdminMemberPayload] = Field(default_factory=list)
    team_details: List[AdminTeamDetailPayload] = Field(default_factory=list)
    annotation_samples: List[AdminAnnotationSamplePayload] = Field(default_factory=list)
    submissions: List[AdminSubmissionPayload] = Field(default_factory=list)
    leaderboard: List[AdminLeaderboardEntryPayload] = Field(default_factory=list)
