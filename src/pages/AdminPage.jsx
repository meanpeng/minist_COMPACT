import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  buildApiUrl,
  createCompetition,
  deleteAnnotation,
  deleteMember,
  deleteSubmission,
  deleteTeam,
  endCompetition,
  fetchAdminBootstrap,
  resetTeamInviteCode,
  startCompetition,
  updateAdminSettings,
} from '../lib/api';

const REFRESH_INTERVAL_MS = 10000;

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '--';
}

function formatPercent(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? `${(value * 100).toFixed(2)}%` : '--';
}

function formatCountdown(seconds) {
  if (typeof seconds !== 'number') {
    return '--';
  }
  const safeSeconds = Math.max(seconds, 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainSeconds = safeSeconds % 60;
  return [hours, minutes, remainSeconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function getStatusLabel(status) {
  if (status === 'not_started') {
    return '未开始';
  }
  if (status === 'running') {
    return '进行中';
  }
  if (status === 'ended') {
    return '已结束';
  }
  return '--';
}

function getRemainingSeconds(settings) {
  if (!settings) {
    return null;
  }
  if (settings.effective_status === 'ended') {
    return 0;
  }
  if (settings.effective_status === 'running') {
    return settings.seconds_until_end ?? null;
  }
  return settings.seconds_until_start ?? null;
}

function createFormState(settings) {
  if (!settings) {
    return {
      competition_name: '',
      start_time: '',
      end_time: '',
      manual_status: '',
      annotation_goal: 50,
      submission_limit: 10,
      submission_cooldown_minutes: 5,
      allow_submission: true,
    };
  }

  return {
    competition_name: settings.competition_name || '',
    start_time: settings.start_time ? settings.start_time.slice(0, 16) : '',
    end_time: settings.end_time ? settings.end_time.slice(0, 16) : '',
    manual_status: settings.manual_status || '',
    annotation_goal: settings.annotation_goal,
    submission_limit: settings.submission_limit,
    submission_cooldown_minutes: settings.submission_cooldown_minutes,
    allow_submission: settings.allow_submission,
  };
}

function buildTeamDetailMap(teamDetails) {
  return Object.fromEntries(teamDetails.map((detail) => [detail.team_id, detail]));
}

function AdminPage() {
  const [bootstrap, setBootstrap] = useState(null);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingCompetition, setIsCreatingCompetition] = useState(false);
  const [newCompetitionName, setNewCompetitionName] = useState('');
  const [activeAction, setActiveAction] = useState('');
  const [teamQuery, setTeamQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [settingsForm, setSettingsForm] = useState(() => createFormState(null));

  useEffect(() => {
    let isActive = true;

    async function loadBootstrap(competitionId, { silent } = { silent: false }) {
      if (!silent) {
        setIsLoading(true);
      }

      try {
        const response = await fetchAdminBootstrap(competitionId);
        if (!isActive) {
          return;
        }

        setBootstrap(response);
        setSelectedCompetitionId(response.selected_competition_id || '');
        setSettingsForm(createFormState(response.settings));
        setErrorMessage('');
      } catch (error) {
        if (isActive) {
          setErrorMessage(error instanceof ApiError ? error.message : '教师后台加载失败。');
        }
      } finally {
        if (isActive && !silent) {
          setIsLoading(false);
        }
      }
    }

    loadBootstrap(selectedCompetitionId || undefined);
    const intervalId = window.setInterval(() => {
      loadBootstrap(selectedCompetitionId || undefined, { silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [selectedCompetitionId]);

  useEffect(() => {
    if (!successMessage) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => setSuccessMessage(''), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [successMessage]);

  const settings = bootstrap?.settings;
  const overview = bootstrap?.overview;
  const competitions = bootstrap?.competitions || [];
  const leaderboard = bootstrap?.leaderboard || [];

  const groupedCompetitions = useMemo(() => ({
    running: competitions.filter((item) => item.effective_status === 'running'),
    ended: competitions.filter((item) => item.effective_status === 'ended'),
    notStarted: competitions.filter((item) => item.effective_status === 'not_started'),
  }), [competitions]);

  const teamDetailMap = useMemo(() => buildTeamDetailMap(bootstrap?.team_details || []), [bootstrap?.team_details]);

  const filteredTeams = useMemo(() => {
    const keyword = teamQuery.trim().toLowerCase();
    return (bootstrap?.teams || []).filter((team) => (
      !keyword ||
      team.name.toLowerCase().includes(keyword) ||
      team.invite_code.toLowerCase().includes(keyword)
    ));
  }, [bootstrap?.teams, teamQuery]);

  const filteredMembers = useMemo(() => {
    const keyword = memberQuery.trim().toLowerCase();
    return (bootstrap?.members || []).filter((member) => (
      !keyword ||
      member.username.toLowerCase().includes(keyword) ||
      member.team_name.toLowerCase().includes(keyword)
    ));
  }, [bootstrap?.members, memberQuery]);

  async function runBootstrapAction(actionKey, action, successText) {
    setActiveAction(actionKey);
    setErrorMessage('');

    try {
      const response = await action();
      setBootstrap(response);
      setSelectedCompetitionId(response.selected_competition_id || response.settings.competition_id || '');
      setSettingsForm(createFormState(response.settings));
      setSuccessMessage(successText);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '操作失败。');
    } finally {
      setActiveAction('');
    }
  }

  async function handleCreateCompetition(event) {
    event.preventDefault();
    if (!newCompetitionName.trim()) {
      setErrorMessage('请输入比赛名称。');
      return;
    }

    setIsCreatingCompetition(true);
    setErrorMessage('');

    try {
      const response = await createCompetition({ competition_name: newCompetitionName.trim() });
      setBootstrap(response);
      setSelectedCompetitionId(response.selected_competition_id || response.settings.competition_id);
      setSettingsForm(createFormState(response.settings));
      setNewCompetitionName('');
      setSuccessMessage('新比赛已创建。');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '创建比赛失败。');
    } finally {
      setIsCreatingCompetition(false);
    }
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    if (!settings?.competition_id) {
      return;
    }

    setIsSaving(true);
    setErrorMessage('');

    try {
      await updateAdminSettings(settings.competition_id, {
        competition_name: settingsForm.competition_name,
        start_time: settingsForm.start_time ? new Date(settingsForm.start_time).toISOString() : null,
        end_time: settingsForm.end_time ? new Date(settingsForm.end_time).toISOString() : null,
        manual_status: settingsForm.manual_status || null,
        annotation_goal: Number(settingsForm.annotation_goal),
        submission_limit: Number(settingsForm.submission_limit),
        submission_cooldown_minutes: Number(settingsForm.submission_cooldown_minutes),
        allow_submission: Boolean(settingsForm.allow_submission),
      });
      const response = await fetchAdminBootstrap(settings.competition_id);
      setBootstrap(response);
      setSelectedCompetitionId(response.selected_competition_id || settings.competition_id);
      setSettingsForm(createFormState(response.settings));
      setSuccessMessage('比赛设置已保存。');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '保存设置失败。');
    } finally {
      setIsSaving(false);
    }
  }

  function renderCompetitionGroup(title, items) {
    return (
      <section className="admin-list-group">
        <div className="admin-list-group-header">
          <h3>{title}</h3>
          <span>{items.length}</span>
        </div>
        <div className="admin-list-stack">
          {items.length ? items.map((competition) => (
            <button
              key={competition.id}
              type="button"
              className={competition.id === selectedCompetitionId ? 'admin-list-card admin-list-card-active' : 'admin-list-card'}
              onClick={() => setSelectedCompetitionId(competition.id)}
            >
              <strong>{competition.name}</strong>
              <span>{getStatusLabel(competition.effective_status)}</span>
              <small>{formatDateTime(competition.end_time || competition.created_at)}</small>
            </button>
          )) : (
            <div className="admin-empty admin-list-empty">暂无比赛。</div>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className="admin-page">
      <div className="admin-shell admin-layout">
        <aside className="admin-sidebar admin-panel">
          <div className="admin-panel-header">
            <h2>比赛列表</h2>
            <a href="#begin" className="admin-link-back">返回学生端</a>
          </div>

          <form className="admin-create-form" onSubmit={handleCreateCompetition}>
            <input value={newCompetitionName} onChange={(event) => setNewCompetitionName(event.target.value)} placeholder="新比赛名称" />
            <button type="submit" className="admin-button" disabled={isCreatingCompetition}>
              {isCreatingCompetition ? '创建中...' : '新建比赛'}
            </button>
          </form>

          {renderCompetitionGroup('正在进行', groupedCompetitions.running)}
          {renderCompetitionGroup('已结束', groupedCompetitions.ended)}
          {renderCompetitionGroup('未开始', groupedCompetitions.notStarted)}
        </aside>

        <div className="admin-content">
          <header className="admin-hero">
            <div>
              <p className="admin-eyebrow">Teacher Console</p>
              <h1>{settings?.competition_name || '比赛管理'}</h1>
              <p className="admin-subtitle">
                当前状态：{getStatusLabel(settings?.effective_status)}，开始 {formatDateTime(settings?.start_time)}，结束 {formatDateTime(settings?.end_time)}
              </p>
            </div>

            <div className="admin-hero-actions">
              <div className="admin-countdown-card">
                <span>剩余时间</span>
                <strong>{formatCountdown(getRemainingSeconds(settings))}</strong>
              </div>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                disabled={activeAction === 'start' || !settings?.competition_id || settings?.effective_status === 'ended'}
                onClick={() => runBootstrapAction(
                  'start',
                  async () => {
                    await startCompetition(settings.competition_id);
                    return fetchAdminBootstrap(settings.competition_id);
                  },
                  '比赛已开始。',
                )}
              >
                手动开始
              </button>
              <button
                type="button"
                className="admin-button admin-button-danger"
                disabled={activeAction === 'end' || !settings?.competition_id}
                onClick={() => runBootstrapAction(
                  'end',
                  async () => {
                    await endCompetition(settings.competition_id);
                    return fetchAdminBootstrap(settings.competition_id);
                  },
                  '比赛已结束，快照已保留。',
                )}
              >
                手动结束
              </button>
            </div>
          </header>

          {errorMessage ? <div className="admin-banner admin-banner-error">{errorMessage}</div> : null}
          {successMessage ? <div className="admin-banner admin-banner-success">{successMessage}</div> : null}
          {isLoading ? <div className="admin-banner">后台数据加载中...</div> : null}

          <section className="admin-summary-grid">
            <article className="admin-stat-card"><span>队伍总数</span><strong>{overview?.team_count ?? '--'}</strong></article>
            <article className="admin-stat-card"><span>成员总数</span><strong>{overview?.member_count ?? '--'}</strong></article>
            <article className="admin-stat-card"><span>标注总量</span><strong>{overview?.annotation_count ?? '--'}</strong></article>
            <article className="admin-stat-card"><span>已达标队伍</span><strong>{overview?.qualified_team_count ?? '--'}</strong></article>
            <article className="admin-stat-card"><span>已提交队伍</span><strong>{overview?.submitted_team_count ?? '--'}</strong></article>
            <article className="admin-stat-card"><span>当前榜首</span><strong>{overview?.current_leader?.team_name || '--'}</strong><small>{formatPercent(overview?.current_leader?.accuracy)}</small></article>
          </section>

          <div className="admin-grid-two">
            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>比赛设置</h2>
                <span>{formatDateTime(settings?.current_time)}</span>
              </div>

              <form className="admin-form" onSubmit={handleSaveSettings}>
                <label>
                  比赛名称
                  <input value={settingsForm.competition_name} onChange={(event) => setSettingsForm((current) => ({ ...current, competition_name: event.target.value }))} />
                </label>
                <label>
                  开始时间
                  <input type="datetime-local" value={settingsForm.start_time} onChange={(event) => setSettingsForm((current) => ({ ...current, start_time: event.target.value }))} />
                </label>
                <label>
                  结束时间
                  <input type="datetime-local" value={settingsForm.end_time} onChange={(event) => setSettingsForm((current) => ({ ...current, end_time: event.target.value }))} />
                </label>
                <label>
                  手动状态覆盖
                  <select value={settingsForm.manual_status} onChange={(event) => setSettingsForm((current) => ({ ...current, manual_status: event.target.value }))}>
                    <option value="">按时间自动判断</option>
                    <option value="not_started">未开始</option>
                    <option value="running">进行中</option>
                    <option value="ended">已结束</option>
                  </select>
                </label>
                <label>
                  标注目标
                  <input type="number" min="0" value={settingsForm.annotation_goal} onChange={(event) => setSettingsForm((current) => ({ ...current, annotation_goal: event.target.value }))} />
                </label>
                <label>
                  每队最大提交次数
                  <input type="number" min="1" value={settingsForm.submission_limit} onChange={(event) => setSettingsForm((current) => ({ ...current, submission_limit: event.target.value }))} />
                </label>
                <label>
                  提交冷却时间（分钟）
                  <input type="number" min="0" value={settingsForm.submission_cooldown_minutes} onChange={(event) => setSettingsForm((current) => ({ ...current, submission_cooldown_minutes: event.target.value }))} />
                </label>
                <label className="admin-checkbox">
                  <input type="checkbox" checked={settingsForm.allow_submission} onChange={(event) => setSettingsForm((current) => ({ ...current, allow_submission: event.target.checked }))} />
                  允许提交成绩
                </label>
                <button type="submit" className="admin-button" disabled={isSaving}>{isSaving ? '保存中...' : '保存设置'}</button>
              </form>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>最近提交</h2>
                <span>{overview?.recent_submissions?.length || 0} 条</span>
              </div>

              <div className="admin-mini-list">
                {(overview?.recent_submissions || []).length ? overview.recent_submissions.map((item) => (
                  <div key={item.id} className="admin-mini-row">
                    <div>
                      <strong>{item.team_name}</strong>
                      <span>{item.username}</span>
                    </div>
                    <div>
                      <strong>{formatPercent(item.accuracy)}</strong>
                      <span>{formatDateTime(item.created_at)}</span>
                    </div>
                  </div>
                )) : <p className="admin-empty">暂无提交记录。</p>}
              </div>
            </section>
          </div>

          <section className="admin-panel">
            <div className="admin-panel-header">
              <h2>队伍管理</h2>
              <input className="admin-search" placeholder="搜索队伍名或邀请码" value={teamQuery} onChange={(event) => setTeamQuery(event.target.value)} />
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>队伍</th>
                    <th>人数</th>
                    <th>开始/结束</th>
                    <th>剩余时间</th>
                    <th>标注进度</th>
                    <th>成员贡献</th>
                    <th>最佳成绩</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTeams.length ? filteredTeams.map((team) => (
                    <tr key={team.id}>
                      <td>
                        <div className="admin-cell-stack">
                          <strong>{team.name}</strong>
                          <span>{team.invite_code}</span>
                          <span>{formatDateTime(team.created_at)}</span>
                        </div>
                      </td>
                      <td>{team.member_count}</td>
                      <td><div className="admin-cell-stack"><span>{formatDateTime(settings?.start_time)}</span><span>{formatDateTime(settings?.end_time)}</span></div></td>
                      <td>{formatCountdown(getRemainingSeconds(settings))}</td>
                      <td><div className="admin-cell-stack"><strong>{team.annotation_count} / {settings?.annotation_goal ?? '--'}</strong><span>{team.has_reached_goal ? '已达标' : `还差 ${team.remaining_to_goal}`}</span></div></td>
                      <td><div className="admin-member-contrib">{(teamDetailMap[team.id]?.member_contributions || []).map((member) => <span key={member.user_id}>{member.username} {member.annotation_count}</span>)}</div></td>
                      <td><div className="admin-cell-stack"><strong>{formatPercent(team.best_accuracy)}</strong><span>{team.best_param_count?.toLocaleString?.() || '--'} params</span><span>{team.best_submitted_by || '--'}</span></div></td>
                      <td>
                        <div className="admin-action-row">
                          <button type="button" className="admin-button admin-button-ghost" disabled={activeAction === `reset-${team.id}` || !settings?.competition_id} onClick={() => runBootstrapAction(`reset-${team.id}`, () => resetTeamInviteCode(settings.competition_id, team.id), `${team.name} 的邀请码已重置。`)}>重置邀请码</button>
                          <button
                            type="button"
                            className="admin-button admin-button-danger-lite"
                            disabled={activeAction === `delete-team-${team.id}` || !settings?.competition_id}
                            onClick={() => {
                              if (!window.confirm(`确认删除队伍“${team.name}”吗？`)) {
                                return;
                              }
                              runBootstrapAction(`delete-team-${team.id}`, () => deleteTeam(settings.competition_id, team.id), `${team.name} 已删除。`);
                            }}
                          >
                            删除队伍
                          </button>
                        </div>
                      </td>
                    </tr>
                  )) : <tr><td colSpan="8" className="admin-empty">没有匹配的队伍。</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <div className="admin-grid-two">
            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>成员管理</h2>
                <input className="admin-search" placeholder="搜索成员或队伍" value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} />
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>队伍</th>
                      <th>标注数</th>
                      <th>提交数</th>
                      <th>加入时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMembers.length ? filteredMembers.map((member) => (
                      <tr key={member.id}>
                        <td>{member.username}</td>
                        <td>{member.team_name}</td>
                        <td>{member.annotation_count}</td>
                        <td>{member.submission_count}</td>
                        <td>{formatDateTime(member.created_at)}</td>
                        <td>
                          <button
                            type="button"
                            className="admin-button admin-button-danger-lite"
                            disabled={activeAction === `delete-member-${member.id}` || !settings?.competition_id}
                            onClick={() => {
                              if (!window.confirm(`确认移除成员“${member.username}”吗？`)) {
                                return;
                              }
                              runBootstrapAction(`delete-member-${member.id}`, () => deleteMember(settings.competition_id, member.id), `${member.username} 已移除。`);
                            }}
                          >
                            删除成员
                          </button>
                        </td>
                      </tr>
                    )) : <tr><td colSpan="6" className="admin-empty">没有匹配的成员。</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>排行榜</h2>
                <span>{settings?.effective_status === 'ended' ? '历史快照' : '实时数据'}</span>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>排名</th>
                      <th>队伍</th>
                      <th>准确率</th>
                      <th>参数量</th>
                      <th>提交人</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.length ? leaderboard.map((entry) => (
                      <tr key={entry.team_id}>
                        <td>#{entry.rank}</td>
                        <td>{entry.team_name}</td>
                        <td>{formatPercent(entry.accuracy)}</td>
                        <td>{entry.param_count.toLocaleString()}</td>
                        <td>{entry.submitted_by}</td>
                        <td>{formatDateTime(entry.created_at)}</td>
                      </tr>
                    )) : <tr><td colSpan="6" className="admin-empty">暂无排行榜数据。</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="admin-grid-two">
            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>标注样本</h2>
                <span>{bootstrap?.annotation_samples?.length || 0} 条</span>
              </div>

              <div className="admin-sample-grid">
                {(bootstrap?.annotation_samples || []).length ? bootstrap.annotation_samples.map((sample) => (
                  <article key={sample.id} className="admin-sample-card">
                    <img src={buildApiUrl(sample.image_url)} alt={`label-${sample.label}`} />
                    <div className="admin-sample-copy">
                      <strong>{sample.team_name}</strong>
                      <span>{sample.username}</span>
                      <span>标签 {sample.label}</span>
                      <span>{formatDateTime(sample.created_at)}</span>
                    </div>
                    <button
                      type="button"
                      className="admin-button admin-button-danger-lite"
                      disabled={activeAction === `delete-annotation-${sample.id}` || !settings?.competition_id}
                      onClick={() => {
                        if (!window.confirm('确认删除这条标注样本吗？')) {
                          return;
                        }
                        runBootstrapAction(`delete-annotation-${sample.id}`, () => deleteAnnotation(settings.competition_id, sample.id), '标注样本已删除。');
                      }}
                    >
                      删除标注
                    </button>
                  </article>
                )) : <p className="admin-empty">暂无标注样本。</p>}
              </div>
            </section>

            <section className="admin-panel">
              <div className="admin-panel-header">
                <h2>成绩记录</h2>
                <span>{bootstrap?.submissions?.length || 0} 条</span>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>队伍</th>
                      <th>成员</th>
                      <th>准确率</th>
                      <th>参数量</th>
                      <th>提交时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(bootstrap?.submissions || []).length ? bootstrap.submissions.map((submission) => (
                      <tr key={submission.id}>
                        <td>{submission.team_name}</td>
                        <td>{submission.username}</td>
                        <td>{formatPercent(submission.accuracy)}</td>
                        <td>{submission.param_count.toLocaleString()}</td>
                        <td>{formatDateTime(submission.created_at)}</td>
                        <td>
                          <button
                            type="button"
                            className="admin-button admin-button-danger-lite"
                            disabled={activeAction === `delete-submission-${submission.id}` || !settings?.competition_id}
                            onClick={() => {
                              if (!window.confirm('确认删除这条提交成绩吗？')) {
                                return;
                              }
                              runBootstrapAction(`delete-submission-${submission.id}`, () => deleteSubmission(settings.competition_id, submission.id), '提交记录已删除。');
                            }}
                          >
                            删除提交
                          </button>
                        </td>
                      </tr>
                    )) : <tr><td colSpan="6" className="admin-empty">暂无提交记录。</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

export default AdminPage;
