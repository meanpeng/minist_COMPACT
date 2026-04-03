import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import {
  ANNOTATION_STATS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
} from '../lib/session';

const { fetchSessionMock, fetchAnnotationStatsMock } = vi.hoisted(() => ({
  fetchSessionMock: vi.fn(),
  fetchAnnotationStatsMock: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    fetchSession: fetchSessionMock,
    fetchAnnotationStats: fetchAnnotationStatsMock,
  };
});

vi.mock('../hooks/useCompetitionTimer', () => ({
  useCompetitionTimer: () => ({ label: '比赛状态', value: '00:42:00' }),
}));

vi.mock('../pages/BeginPage', () => ({
  default: () => <div>begin-page</div>,
}));

vi.mock('../pages/DashboardPage', () => ({
  default: () => <div>dashboard-page</div>,
}));

vi.mock('../pages/AnnotationPage', () => ({
  default: () => <div>annotation-page</div>,
}));

vi.mock('../pages/ModelingPage', () => ({
  default: () => <div>modeling-page</div>,
}));

vi.mock('../pages/TrainingPage', () => ({
  default: () => <div>training-page</div>,
}));

vi.mock('../pages/SubmissionPage', () => ({
  default: () => <div>submission-page</div>,
}));

vi.mock('../pages/AdminNeoPage', () => ({
  default: () => <div>admin-page</div>,
}));

const storedSession = {
  session_token: 'session-1',
  expires_at: '2026-04-04T00:00:00+00:00',
  competition: {
    id: 'default-competition',
    name: 'MNIST Classroom Challenge',
    created_at: '2026-04-03T00:00:00+00:00',
  },
  competition_status: {
    competition_id: 'default-competition',
    competition_name: 'MNIST Classroom Challenge',
    effective_status: 'running',
    current_time: '2026-04-03T00:00:00+00:00',
    annotation_goal: 3,
    team_member_limit: 2,
    submission_limit: 3,
    submission_cooldown_minutes: 0,
    allow_submission: true,
    is_submission_open: true,
  },
  user: {
    id: 'user-1',
    username: 'alice',
  },
  team: {
    id: 'team-1',
    name: 'Alpha Squad',
    invite_code: 'ABCD12',
  },
};

function saveBootstrapState({ session = storedSession, stats } = {}) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  if (stats) {
    window.localStorage.setItem(ANNOTATION_STATS_STORAGE_KEY, JSON.stringify(stats));
  }
}

describe('Stage 2 app flow', () => {
  beforeEach(() => {
    vi.useRealTimers();
    fetchSessionMock.mockReset();
    fetchAnnotationStatsMock.mockReset();
  });

  it('restores session from storage and keeps polling session plus annotation stats', async () => {
    saveBootstrapState({
      stats: {
        team_id: 'team-1',
        total_count: 3,
        goal: 3,
        remaining_to_goal: 0,
        progress_ratio: 1,
        counts_by_label: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
      },
    });
    window.location.hash = '#dashboard';

    fetchSessionMock.mockResolvedValue(storedSession);
    fetchAnnotationStatsMock.mockResolvedValue({
      team_id: 'team-1',
      total_count: 3,
      goal: 3,
      remaining_to_goal: 0,
      progress_ratio: 1,
      counts_by_label: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    });

    const intervalCallbacks = [];
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    });

    render(<App />);

    await screen.findByText('dashboard-page');
    await waitFor(() => {
      expect(fetchSessionMock).toHaveBeenCalledTimes(1);
      expect(fetchAnnotationStatsMock).toHaveBeenCalledTimes(1);
    });

    expect(intervalCallbacks.length).toBeGreaterThanOrEqual(2);

    for (const callback of intervalCallbacks) {
      await callback();
    }

    await waitFor(() => {
      expect(fetchSessionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(fetchAnnotationStatsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    setIntervalSpy.mockRestore();
  });

  it('redirects locked training route back to annotation until the goal is reached', async () => {
    saveBootstrapState({
      stats: {
        team_id: 'team-1',
        total_count: 1,
        goal: 3,
        remaining_to_goal: 2,
        progress_ratio: 1 / 3,
        counts_by_label: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    });
    window.location.hash = '#training';

    fetchSessionMock.mockResolvedValue(storedSession);
    fetchAnnotationStatsMock.mockResolvedValue({
      team_id: 'team-1',
      total_count: 1,
      goal: 3,
      remaining_to_goal: 2,
      progress_ratio: 1 / 3,
      counts_by_label: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });

    render(<App />);

    await screen.findByText('annotation-page');
    expect(window.location.hash).toBe('#annotation');
  });
});
