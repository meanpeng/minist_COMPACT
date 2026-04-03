import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BeginPage from '../pages/BeginPage';

const { checkServerHealthMock, fetchCompetitionsMock, createTeamMock, joinTeamMock } = vi.hoisted(() => ({
  checkServerHealthMock: vi.fn(),
  fetchCompetitionsMock: vi.fn(),
  createTeamMock: vi.fn(),
  joinTeamMock: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    checkServerHealth: checkServerHealthMock,
    fetchCompetitions: fetchCompetitionsMock,
    createTeam: createTeamMock,
    joinTeam: joinTeamMock,
  };
});

describe('Stage 2 begin page flow', () => {
  beforeEach(() => {
    checkServerHealthMock.mockReset();
    fetchCompetitionsMock.mockReset();
    createTeamMock.mockReset();
    joinTeamMock.mockReset();

    checkServerHealthMock.mockResolvedValue({ status: 'ok' });
    fetchCompetitionsMock.mockResolvedValue([
      {
        id: 'default-competition',
        name: 'MNIST Classroom Challenge',
        created_at: '2026-04-03T00:00:00+00:00',
      },
    ]);
  });

  it('creates a team and reports the invite-code notice path', async () => {
    const onSessionReady = vi.fn();
    const nextSession = {
      session_token: 'token-create',
      team: { invite_code: 'JOIN12' },
    };
    createTeamMock.mockResolvedValue(nextSession);

    const view = render(<BeginPage onSessionReady={onSessionReady} session={null} />);

    await view.findByText('MNIST Classroom Challenge');

    fireEvent.change(view.getByPlaceholderText('输入昵称'), {
      target: { value: 'alice' },
    });
    fireEvent.change(view.getByPlaceholderText('队伍名称'), {
      target: { value: 'Alpha Squad' },
    });
    fireEvent.click(view.getByRole('button', { name: '创建队伍' }));

    await waitFor(() => {
      expect(createTeamMock).toHaveBeenCalledWith({
        competition_id: 'default-competition',
        username: 'alice',
        team_name: 'Alpha Squad',
      });
      expect(onSessionReady).toHaveBeenCalledWith(nextSession, {
        showInviteCodeNotice: true,
      });
    });
  });

  it('joins a team with the invite code entered by the student', async () => {
    const onSessionReady = vi.fn();
    const nextSession = {
      session_token: 'token-join',
      team: { invite_code: 'JOIN12' },
    };
    joinTeamMock.mockResolvedValue(nextSession);

    const view = render(<BeginPage onSessionReady={onSessionReady} session={null} />);

    await view.findByText('MNIST Classroom Challenge');

    fireEvent.change(view.getByPlaceholderText('输入昵称'), {
      target: { value: 'bob' },
    });
    fireEvent.change(view.getByPlaceholderText('输入邀请码'), {
      target: { value: 'join12' },
    });
    fireEvent.click(view.getByRole('button', { name: '加入队伍' }));

    await waitFor(() => {
      expect(joinTeamMock).toHaveBeenCalledWith({
        competition_id: 'default-competition',
        username: 'bob',
        invite_code: 'JOIN12',
      });
      expect(onSessionReady).toHaveBeenCalledWith(nextSession);
    });
  });
});
