export const SESSION_STORAGE_KEY = 'mnist_compact_session';
export const ANNOTATION_STATS_STORAGE_KEY = 'mnist_compact_annotation_stats';
export const ADMIN_TOKEN_STORAGE_KEY = 'mnist_compact_admin_token';

export function loadStoredSession() {
  try {
    const rawValue = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}

export function saveStoredSession(session) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export function loadStoredAnnotationStats() {
  try {
    const rawValue = window.localStorage.getItem(ANNOTATION_STATS_STORAGE_KEY);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch {
    return null;
  }
}

export function saveStoredAnnotationStats(stats) {
  window.localStorage.setItem(ANNOTATION_STATS_STORAGE_KEY, JSON.stringify(stats));
}

export function clearStoredAnnotationStats() {
  window.localStorage.removeItem(ANNOTATION_STATS_STORAGE_KEY);
}

export function loadStoredAdminToken() {
  try {
    const rawValue = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    return rawValue ? rawValue.trim() : '';
  } catch {
    return '';
  }
}

export function saveStoredAdminToken(adminToken) {
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
}

export function clearStoredAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}
