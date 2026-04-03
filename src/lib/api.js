import { loadStoredAdminToken } from './session';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || 'http://localhost:8000';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  const { sessionToken, adminToken, headers: optionHeaders, ...requestOptions } = options;
  const authHeaders = {};
  if (sessionToken) {
    authHeaders.Authorization = `Bearer ${sessionToken}`;
  }
  if (adminToken) {
    authHeaders['X-Admin-Token'] = adminToken;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(optionHeaders || {}),
    },
    ...requestOptions,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      payload?.detail || 'Request failed. Please try again.',
      response.status,
      payload?.code || 'REQUEST_FAILED',
    );
  }

  return response.json();
}

function getAdminToken(adminToken) {
  return adminToken || loadStoredAdminToken();
}

export function buildApiUrl(path) {
  if (!path.startsWith('/')) {
    return `${API_BASE_URL}/${path}`;
  }

  return `${API_BASE_URL}${path}`;
}

export function createTeam(payload) {
  return request('/api/auth/create-team', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function joinTeam(payload) {
  return request('/api/auth/join-team', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchCompetitions() {
  return request('/api/competitions');
}

export function fetchSession(sessionToken) {
  return request('/api/auth/session', { sessionToken });
}

export function fetchDashboard(sessionToken) {
  return request('/api/dashboard', { sessionToken });
}

export function fetchAnnotationStats(sessionToken) {
  return request('/api/annotation/stats', { sessionToken });
}

export function submitAnnotation(payload, sessionToken) {
  return request('/api/annotation/submit', {
    method: 'POST',
    sessionToken,
    body: JSON.stringify(payload),
  });
}

export function fetchModelConfig(sessionToken) {
  return request('/api/modeling/config', { sessionToken });
}

export function saveModelConfig(payload, sessionToken) {
  return request('/api/modeling/config', {
    method: 'PUT',
    sessionToken,
    body: JSON.stringify(payload),
  });
}

export function fetchTrainingBootstrap(sessionToken) {
  return request('/api/training/bootstrap', { sessionToken });
}

export function saveTrainingRun(payload, sessionToken) {
  return request('/api/training/run', {
    method: 'PUT',
    sessionToken,
    body: JSON.stringify(payload),
  });
}

export function fetchSubmissionBootstrap(sessionToken) {
  return request('/api/submission/bootstrap', { sessionToken });
}

export function evaluateSubmission(payload, sessionToken) {
  return request('/api/submission/evaluate', {
    method: 'POST',
    sessionToken,
    body: JSON.stringify(payload),
  });
}

export function createCompetition(payload) {
  return request('/api/admin/competitions', {
    method: 'POST',
    adminToken: getAdminToken(),
    body: JSON.stringify(payload),
  });
}

export function fetchAdminBootstrap(competitionId, adminToken = undefined) {
  if (!competitionId) {
    return request('/api/admin/bootstrap', { adminToken: getAdminToken(adminToken) });
  }

  return request(`/api/admin/competitions/${competitionId}/bootstrap`, { adminToken: getAdminToken(adminToken) });
}

export function updateAdminSettings(competitionId, payload, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/settings`, {
    method: 'PUT',
    adminToken: getAdminToken(adminToken),
    body: JSON.stringify(payload),
  });
}

export function endCompetition(competitionId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/settings/end`, {
    method: 'POST',
    adminToken: getAdminToken(adminToken),
  });
}

export function resetTeamInviteCode(competitionId, teamId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/teams/${teamId}/reset-invite`, {
    method: 'POST',
    adminToken: getAdminToken(adminToken),
  });
}

export function deleteTeam(competitionId, teamId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/teams/${teamId}`, {
    method: 'DELETE',
    adminToken: getAdminToken(adminToken),
  });
}

export function deleteMember(competitionId, userId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/members/${userId}`, {
    method: 'DELETE',
    adminToken: getAdminToken(adminToken),
  });
}

export function deleteAnnotation(competitionId, annotationId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/annotations/${annotationId}`, {
    method: 'DELETE',
    adminToken: getAdminToken(adminToken),
  });
}

export function deleteSubmission(competitionId, submissionId, adminToken = undefined) {
  return request(`/api/admin/competitions/${competitionId}/submissions/${submissionId}`, {
    method: 'DELETE',
    adminToken: getAdminToken(adminToken),
  });
}

export async function checkServerHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) {
    throw new ApiError('Server is unavailable.', response.status, 'SERVER_UNAVAILABLE');
  }

  return response.json();
}
