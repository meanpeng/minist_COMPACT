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
  updateAdminSettings,
} from '../lib/api';

const REFRESH_INTERVAL_MS = 10000;
const MEMBER_AVATAR_URLS = [
  'https://lh3.googleusercontent.com/aida-public/AB6AXuA9_UoT4RDUvKHUxRkW3SgH8IIczmLpvoAiYISsnZHAwg5EnEo2rXn7Vk7q6_BEFw-Oz3t0voPK9mp5EEYN9QfyT0nn3R_jBDf00x3CkZ8N9oYgGqtZ7LHYuw8LZN9U1wrhGVEe3fALYtGsi1I-WUXkPMjK5HL7IwXxIqLLMflUQS4TPei4qIeabU8uoTudKPwLFWcg1C-3r-WsklUQR0FRXyBaaEOUa7LVAXU6F4UOwYhEZAKmyjSeaFCINCvx8nWXA4ihXRPj4u1i',
  'https://lh3.googleusercontent.com/aida-public/AB6AXuCA5RUQdWXBvcIQkZ2NTy6jvpngvxVM5G1MgxZOHY1uGGxAuYc2zkYGckgzTTic67CBGrca3JryloxqwQO1RvnM_gZQ5URDibxzk77XwRAL_ugCEW4yKdtHl4_P-8QJdE_OhEpCcXEB6JZKjU4ibyi320nAhCFQXRHYI5HFpUE0wsNoGBi_YPwikI_0N8Jzfneoqsl0zz5GMu4JuGFLYDX7Ibyyvw3iggR41z1laKDAtNuvUik3K56veUdamGX1XmWBWE4GOh9azf3v',
];

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN') : '--';
}

function formatShortStamp(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function getDateTimeParts(value) {
  if (!value) {
    return {
      date: '',
      hour: '23',
      minute: '59',
    };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return {
      date: '',
      hour: '23',
      minute: '59',
    };
  }

  return {
    date: `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`,
    hour: padNumber(date.getHours()),
    minute: padNumber(date.getMinutes()),
  };
}

function buildLocalIsoDateTime(dateValue, hourValue, minuteValue) {
  if (!dateValue) return null;
  const dateTime = new Date(`${dateValue}T${padNumber(hourValue)}:${padNumber(minuteValue)}`);
  return Number.isNaN(dateTime.getTime()) ? null : dateTime.toISOString();
}

function formatPercent(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? `${(value * 100).toFixed(2)}%` : '--';
}

function formatCompactNumber(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? value.toLocaleString() : '--';
}

function formatCountdownParts(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return ['--', '--', '--', '--'];
  const safeSeconds = Math.max(seconds, 0);
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainSeconds = safeSeconds % 60;
  return [days, hours, minutes, remainSeconds].map((part) => String(part).padStart(2, '0'));
}

function getStatusLabel(status) {
  if (status === 'not_started') return '未开始';
  if (status === 'running') return '进行中';
  if (status === 'ended') return '已结束';
  return '--';
}

function getRemainingSeconds(settings) {
  if (!settings) return null;
  if (settings.effective_status === 'ended') return 0;
  if (settings.effective_status === 'running') return settings.seconds_until_end ?? null;
  return null;
}

function createFormState(settings) {
  if (!settings) {
    return {
      competition_name: '',
      end_date: '',
      end_hour: '23',
      end_minute: '59',
      manual_status: '',
      annotation_goal: 50,
      team_member_limit: 5,
      submission_limit: 10,
      submission_cooldown_minutes: 5,
      allow_submission: true,
    };
  }

  const endTimeParts = getDateTimeParts(settings.end_time);

  return {
    competition_name: settings.competition_name || '',
    end_date: endTimeParts.date,
    end_hour: endTimeParts.hour,
    end_minute: endTimeParts.minute,
    manual_status: settings.manual_status || '',
    annotation_goal: settings.annotation_goal,
    team_member_limit: settings.team_member_limit,
    submission_limit: settings.submission_limit,
    submission_cooldown_minutes: settings.submission_cooldown_minutes,
    allow_submission: settings.allow_submission,
  };
}

function buildTeamDetailMap(teamDetails) {
  return Object.fromEntries(teamDetails.map((detail) => [detail.team_id, detail]));
}

function getProgressWidth(count, goal) {
  if (!goal) return '0%';
  return `${Math.max(0, Math.min(100, Math.round((count / goal) * 100)))}%`;
}

function getRelativeAge(value) {
  if (!value) return '--';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds} 秒前`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return `${Math.floor(diffHours / 24)} 天前`;
}

function getLoadLabel(teams, members) {
  if (!teams || !members) return '--';
  const occupancy = members / Math.max(teams * 4, 1);
  if (occupancy > 1.2) return '繁忙';
  if (occupancy > 0.8) return '稳定';
  return '良好';
}

function AdminNeoPage() {
  const [bootstrap, setBootstrap] = useState(null);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingCompetition, setIsCreatingCompetition] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newCompetitionName, setNewCompetitionName] = useState('');
  const [activeAction, setActiveAction] = useState('');
  const [settingsForm, setSettingsForm] = useState(() => createFormState(null));

  useEffect(() => {
    let isActive = true;

    async function loadBootstrap(competitionId, { silent, syncForm = false } = { silent: false, syncForm: false }) {
      if (!silent) setIsLoading(true);

      try {
        const response = await fetchAdminBootstrap(competitionId);
        if (!isActive) return;
        setBootstrap(response);
        setSelectedCompetitionId(response.selected_competition_id || '');
        if (syncForm) {
          setSettingsForm(createFormState(response.settings));
        }
        setErrorMessage('');
      } catch (error) {
        if (isActive) {
          setErrorMessage(error instanceof ApiError ? error.message : '赛事管理页加载失败。');
        }
      } finally {
        if (isActive && !silent) setIsLoading(false);
      }
    }

    loadBootstrap(selectedCompetitionId || undefined, { syncForm: true });
    const intervalId = window.setInterval(() => {
      loadBootstrap(selectedCompetitionId || undefined, { silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [selectedCompetitionId]);

  useEffect(() => {
    if (!successMessage) return undefined;
    const timeoutId = window.setTimeout(() => setSuccessMessage(''), 2500);
    return () => window.clearTimeout(timeoutId);
  }, [successMessage]);

  const settings = bootstrap?.settings;
  const overview = bootstrap?.overview;
  const competitions = bootstrap?.competitions || [];
  const teams = bootstrap?.teams || [];
  const members = bootstrap?.members || [];
  const leaderboard = bootstrap?.leaderboard || [];
  const samples = bootstrap?.annotation_samples || [];
  const submissions = bootstrap?.submissions || [];
  const teamDetailMap = useMemo(() => buildTeamDetailMap(bootstrap?.team_details || []), [bootstrap?.team_details]);

  const competitionGroups = useMemo(() => ({
    running: competitions.filter((item) => item.effective_status === 'running'),
    archived: competitions.filter((item) => item.effective_status !== 'running'),
  }), [competitions]);

  const countdownParts = formatCountdownParts(getRemainingSeconds(settings));
  const topLeader = leaderboard[0] || null;
  const loadLabel = getLoadLabel(teams.length, members.length);
  const liveCompetitions = competitionGroups.running.length ? competitionGroups.running : competitions.slice(0, 1);

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
      setErrorMessage('请输入赛事名称。');
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
      setIsCreateModalOpen(false);
      setSuccessMessage('赛事已创建。');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '创建比赛失败。');
    } finally {
      setIsCreatingCompetition(false);
    }
  }

  async function handleSaveSettings(event) {
    event.preventDefault();
    if (!settings?.competition_id) return;

    setIsSaving(true);
    setErrorMessage('');

    try {
      await updateAdminSettings(settings.competition_id, {
        competition_name: settingsForm.competition_name,
        end_time: buildLocalIsoDateTime(settingsForm.end_date, settingsForm.end_hour, settingsForm.end_minute),
        manual_status: settingsForm.manual_status || null,
        annotation_goal: Number(settingsForm.annotation_goal),
        team_member_limit: Number(settingsForm.team_member_limit),
        submission_limit: Number(settingsForm.submission_limit),
        submission_cooldown_minutes: Number(settingsForm.submission_cooldown_minutes),
        allow_submission: Boolean(settingsForm.allow_submission),
      });
      const response = await fetchAdminBootstrap(settings.competition_id);
      setBootstrap(response);
      setSelectedCompetitionId(response.selected_competition_id || settings.competition_id);
      setSettingsForm(createFormState(response.settings));
      setSuccessMessage('设置已保存。');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '保存设置失败。');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="admin-neo-page">
      <div className="admin-neo-scanline" aria-hidden="true" />

      <aside className="admin-neo-sidebar">
        <div className="admin-neo-sidebar-heading">
          <div className="admin-neo-sidebar-title">赛事总览</div>
          <div className="admin-neo-sidebar-subtitle">NEURAL_INDEX</div>
        </div>

        <div className="admin-neo-sidebar-actions">
          <button
            type="button"
            className="admin-neo-create-trigger"
            onClick={() => {
              setErrorMessage('');
              setIsCreateModalOpen(true);
            }}
          >
            <span className="material-symbols-outlined">add_circle</span>
            新建赛事
          </button>
        </div>

        <nav className="admin-neo-sidebar-scroll">
          <section className="admin-neo-sidebar-section">
            <div className="admin-neo-sidebar-label">
              <span className="admin-neo-dot admin-neo-dot-live" />
              进行中的赛事
            </div>
            <div className="admin-neo-sidebar-list">
              {liveCompetitions.length ? liveCompetitions.map((competition) => (
                <button
                  key={competition.id}
                  type="button"
                  className={competition.id === selectedCompetitionId ? 'admin-neo-sidebar-item is-active' : 'admin-neo-sidebar-item'}
                  onClick={() => setSelectedCompetitionId(competition.id)}
                >
                  <span className="material-symbols-outlined">videogame_asset</span>
                  <span>{competition.name}</span>
                </button>
              )) : <p className="admin-neo-empty-copy">暂无进行中的赛事</p>}
            </div>
          </section>

          <section className="admin-neo-sidebar-section">
            <div className="admin-neo-sidebar-label admin-neo-sidebar-label-muted">
              <span className="admin-neo-dot" />
              已归档数据
            </div>
            <div className="admin-neo-sidebar-list">
              {competitionGroups.archived.length ? competitionGroups.archived.map((competition) => (
                <button
                  key={competition.id}
                  type="button"
                  className={competition.id === selectedCompetitionId ? 'admin-neo-sidebar-item is-active is-archived' : 'admin-neo-sidebar-item is-archived'}
                  onClick={() => setSelectedCompetitionId(competition.id)}
                >
                  <span className="material-symbols-outlined">
                    {competition.effective_status === 'ended' ? 'history' : 'database'}
                  </span>
                  <span>{competition.name}</span>
                </button>
              )) : <p className="admin-neo-empty-copy">暂无归档</p>}
            </div>
          </section>
        </nav>

        <div className="admin-neo-sidebar-footer">
          <div className="admin-neo-sidebar-links">
            <span>SYNC: {isLoading ? '同步中' : '在线'}</span>
            <span>当前选择: {settings?.competition_name || '无'}</span>
          </div>
        </div>
      </aside>

      {isCreateModalOpen ? (
        <div
          className="admin-neo-modal-backdrop"
          onClick={() => {
            if (isCreatingCompetition) return;
            setIsCreateModalOpen(false);
          }}
        >
          <div
            className="admin-neo-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-neo-create-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="admin-neo-modal-header">
              <div>
                <div className="admin-neo-modal-kicker">赛事管理</div>
                <h3 id="admin-neo-create-title">新建赛事</h3>
              </div>
              <button
                type="button"
                className="admin-neo-modal-close"
                onClick={() => setIsCreateModalOpen(false)}
                disabled={isCreatingCompetition}
                aria-label="关闭新建赛事弹窗"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form className="admin-neo-modal-form" onSubmit={handleCreateCompetition}>
              <label>
                <span>赛事名称</span>
                <input
                  type="text"
                  value={newCompetitionName}
                  onChange={(event) => setNewCompetitionName(event.target.value)}
                  placeholder="例如：2026 巅峰赛"
                  autoFocus
                />
              </label>

              <div className="admin-neo-modal-actions">
                <button type="button" className="admin-neo-outline-button" onClick={() => setIsCreateModalOpen(false)} disabled={isCreatingCompetition}>
                  取消
                </button>
                <button type="submit" className="admin-neo-action-button" disabled={isCreatingCompetition}>
                  {isCreatingCompetition ? '创建中...' : '创建赛事'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <main className="admin-neo-main">
        <section className="admin-neo-overview-grid" id="overview">
          <div className="admin-neo-overview-panel">
            <div className="admin-neo-overview-status">状态: {getStatusLabel(settings?.effective_status)}</div>

            <div className="admin-neo-overview-head">
              <div>
                <h2>{settings?.competition_name || 'NEURAL_ETHICS_V2'}</h2>
                <div className="admin-neo-overview-dates">
                  <span>结束: {formatDateTime(settings?.end_time)}</span>
                </div>
              </div>
            </div>

            <div className="admin-neo-countdown-grid">
              {[
                { label: '天', value: countdownParts[0] },
                { label: '小时', value: countdownParts[1] },
                { label: '分钟', value: countdownParts[2] },
                { label: '秒', value: countdownParts[3] },
              ].map((item) => (
                <div key={item.label} className="admin-neo-countdown-card">
                  <div className="admin-neo-countdown-value">{item.value}</div>
                  <div className="admin-neo-countdown-label">{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="admin-neo-health-panel">
            <div>
              <h3>赛事状态</h3>
              <div className="admin-neo-health-metrics">
                <div><span>在线率</span><strong>{isLoading ? '同步中...' : '99.98%'}</strong></div>
                <div><span>延迟</span><strong>{isLoading ? '--' : '<100ms'}</strong></div>
                <div><span>负载</span><strong>{loadLabel}</strong></div>
              </div>
            </div>

            <div className="admin-neo-terminal-log">
              <span>&gt; 正在验证核心服务...</span>
              <span>&gt; 赛事 ID {settings?.competition_id || '--'}</span>
              <span>&gt; 提交入口 {settings?.allow_submission ? '开放' : '锁定'}</span>
            </div>
          </div>
        </section>

        {errorMessage ? <div className="admin-neo-banner is-error">{errorMessage}</div> : null}
        {successMessage ? <div className="admin-neo-banner is-success">{successMessage}</div> : null}
        {isLoading ? <div className="admin-neo-banner">正在加载赛事数据...</div> : null}

        <section className="admin-neo-metrics-grid">
          <article className="admin-neo-metric-card">
            <span className="material-symbols-outlined">groups</span>
            <div className="admin-neo-metric-value">{formatCompactNumber(overview?.team_count)}</div>
            <div className="admin-neo-metric-label">队伍</div>
          </article>
          <article className="admin-neo-metric-card">
            <span className="material-symbols-outlined">person</span>
            <div className="admin-neo-metric-value">{formatCompactNumber(overview?.member_count)}</div>
            <div className="admin-neo-metric-label">成员</div>
          </article>
          <article className="admin-neo-metric-card">
            <span className="material-symbols-outlined">edit_note</span>
            <div className="admin-neo-metric-value">{formatCompactNumber(overview?.annotation_count)}</div>
            <div className="admin-neo-metric-label">标注数</div>
          </article>
          <article className="admin-neo-metric-card">
            <span className="material-symbols-outlined">verified</span>
            <div className="admin-neo-metric-value">{formatCompactNumber(overview?.qualified_team_count)}</div>
            <div className="admin-neo-metric-label">达标队伍</div>
          </article>
          <article className="admin-neo-metric-card">
            <span className="material-symbols-outlined">upload_file</span>
            <div className="admin-neo-metric-value">{formatCompactNumber(overview?.submitted_team_count)}</div>
            <div className="admin-neo-metric-label">提交数</div>
          </article>
          <article className="admin-neo-metric-card admin-neo-metric-card-primary">
            <span className="material-symbols-outlined">stars</span>
            <div className="admin-neo-metric-value admin-neo-metric-leader">{topLeader?.team_name || '--'}</div>
            <div className="admin-neo-metric-label admin-neo-metric-label-strong">{formatPercent(topLeader?.accuracy)}</div>
          </article>
        </section>

        <section className="admin-neo-settings-panel">
          <div className="admin-neo-panel-topbar">
            <h3><span className="material-symbols-outlined">tune</span> 赛事设置</h3>
            <div className="admin-neo-panel-actions">
              <button
                type="button"
                className="admin-neo-action-button admin-neo-action-button-danger"
                disabled={!settings?.competition_id || activeAction === 'end'}
                onClick={() => runBootstrapAction(
                  'end',
                  async () => {
                    await endCompetition(settings.competition_id);
                    return fetchAdminBootstrap(settings.competition_id);
                  },
                  '赛事已结束。',
                )}
              >
                结束赛事
              </button>
              <button type="submit" form="admin-neo-settings-form" className="admin-neo-action-button" disabled={isSaving}>
                {isSaving ? '保存中...' : '保存设置'}
              </button>
            </div>
          </div>

          <form id="admin-neo-settings-form" className="admin-neo-settings-grid" onSubmit={handleSaveSettings}>
            <div className="admin-neo-settings-column">
              <label>
                <span>赛事名称</span>
                <input
                  value={settingsForm.competition_name}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, competition_name: event.target.value }))}
                />
              </label>

              <label>
                <span>结束日期</span>
                <input
                  type="date"
                  value={settingsForm.end_date}
                  onChange={(event) => setSettingsForm((current) => ({
                    ...current,
                    end_date: event.target.value,
                  }))}
                />
              </label>

              <div className="admin-neo-settings-split">
                <label>
                  <span>结束小时</span>
                  <select
                    value={settingsForm.end_hour}
                    onChange={(event) => setSettingsForm((current) => ({
                      ...current,
                      end_hour: event.target.value,
                    }))}
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={padNumber(hour)}>
                        {padNumber(hour)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>结束分钟</span>
                  <select
                    value={settingsForm.end_minute}
                    onChange={(event) => setSettingsForm((current) => ({
                      ...current,
                      end_minute: event.target.value,
                    }))}
                  >
                    {Array.from({ length: 60 }, (_, minute) => (
                      <option key={minute} value={padNumber(minute)}>
                        {padNumber(minute)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="admin-neo-settings-column">
              <label>
                <span>标注目标</span>
                <input
                  type="number"
                  min="0"
                  value={settingsForm.annotation_goal}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, annotation_goal: event.target.value }))}
                />
              </label>

              <label>
                <span>队伍人数限制</span>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.team_member_limit}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, team_member_limit: event.target.value }))}
                />
              </label>

              <div className="admin-neo-settings-split">
                <label>
                  <span>提交次数上限</span>
                  <input
                    type="number"
                    min="1"
                    value={settingsForm.submission_limit}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, submission_limit: event.target.value }))}
                  />
                </label>
                <label>
                  <span>冷却时间（分钟）</span>
                  <input
                    type="number"
                    min="0"
                    value={settingsForm.submission_cooldown_minutes}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, submission_cooldown_minutes: event.target.value }))}
                  />
                </label>
              </div>
            </div>

            <div className="admin-neo-settings-togglebox">
              <div className="admin-neo-toggle-row">
                <div>
                  <div className="admin-neo-toggle-title">允许提交</div>
                  <div className="admin-neo-toggle-copy">队伍级全局开关</div>
                </div>
                <label className={settingsForm.allow_submission ? 'admin-neo-switch is-on' : 'admin-neo-switch'}>
                  <input
                    type="checkbox"
                    checked={settingsForm.allow_submission}
                    onChange={(event) => setSettingsForm((current) => ({ ...current, allow_submission: event.target.checked }))}
                  />
                  <span />
                </label>
              </div>

              <div className="admin-neo-toggle-row">
                <div>
                  <div className="admin-neo-toggle-title">手动状态</div>
                  <div className="admin-neo-toggle-copy">覆盖基于时间的状态</div>
                </div>
                <select
                  value={settingsForm.manual_status}
                  onChange={(event) => setSettingsForm((current) => ({ ...current, manual_status: event.target.value }))}
                  className="admin-neo-inline-select"
                >
                  <option value="">自动</option>
                  <option value="not_started">未开始</option>
                  <option value="running">进行中</option>
                  <option value="ended">已结束</option>
                </select>
              </div>

              <button
                type="button"
                className="admin-neo-outline-button"
                disabled={!settings?.competition_id}
                onClick={() => {
                  if (!settings?.competition_id) return;
                  runBootstrapAction('refresh-settings', () => fetchAdminBootstrap(settings.competition_id), '赛事数据已刷新。');
                }}
              >
                重置赛事数据
              </button>
            </div>
          </form>
        </section>

        <section className="admin-neo-registry-grid">
          <div className="admin-neo-table-panel">
            <div className="admin-neo-table-header">
              <h4>队伍列表</h4>
              <span>数量: {teams.length}</span>
            </div>
            <div className="admin-neo-table-wrap">
              <table className="admin-neo-table">
                <thead>
                  <tr>
                    <th>队伍名称</th>
                    <th>邀请码</th>
                    <th>进度</th>
                    <th>分数</th>
                    <th className="is-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.length ? teams.map((team) => (
                    <tr key={team.id}>
                      <td className="is-strong">{team.name}</td>
                      <td className="is-secondary">{team.invite_code}</td>
                      <td>
                        <div className="admin-neo-progress">
                          <div className="admin-neo-progress-bar" style={{ width: getProgressWidth(team.annotation_count, settings?.annotation_goal) }} />
                        </div>
                      </td>
                      <td className="is-primary">{formatPercent(team.best_accuracy)}</td>
                      <td className="is-right">
                        <div className="admin-neo-table-actions">
                          <button
                            type="button"
                            className="admin-neo-table-icon"
                            disabled={!settings?.competition_id || activeAction === `reset-${team.id}`}
                            onClick={() => runBootstrapAction(
                              `reset-${team.id}`,
                              () => resetTeamInviteCode(settings.competition_id, team.id),
                              `${team.name} 邀请码已重置。`,
                            )}
                          >
                            <span className="material-symbols-outlined">refresh</span>
                          </button>
                          <button
                            type="button"
                            className="admin-neo-table-icon is-danger"
                            disabled={!settings?.competition_id || activeAction === `delete-team-${team.id}`}
                            onClick={() => {
                              if (!window.confirm(`确定删除队伍 ${team.name} 吗？`)) return;
                              runBootstrapAction(`delete-team-${team.id}`, () => deleteTeam(settings.competition_id, team.id), `${team.name} 已删除。`);
                            }}
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="admin-neo-empty-cell">暂无队伍</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="admin-neo-table-panel">
            <div className="admin-neo-table-header">
              <h4>成员列表</h4>
              <span>数量: {members.length}</span>
            </div>
            <div className="admin-neo-table-wrap">
              <table className="admin-neo-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>队伍</th>
                    <th>标注</th>
                    <th>提交</th>
                    <th className="is-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {members.length ? members.map((member, index) => (
                    <tr key={member.id}>
                      <td>
                        <div className="admin-neo-member-cell">
                          <div className="admin-neo-member-avatar">
                            <img src={MEMBER_AVATAR_URLS[index % MEMBER_AVATAR_URLS.length]} alt={member.username} />
                          </div>
                          <span className="is-strong">{member.username}</span>
                        </div>
                      </td>
                      <td className="is-muted">{member.team_name}</td>
                      <td>{formatCompactNumber(member.annotation_count)}</td>
                      <td className="is-secondary">{formatCompactNumber(member.submission_count)}</td>
                      <td className="is-right">
                        <button
                          type="button"
                          className="admin-neo-table-icon is-danger"
                          disabled={!settings?.competition_id || activeAction === `delete-member-${member.id}`}
                          onClick={() => {
                            if (!window.confirm(`确定删除成员 ${member.username} 吗？`)) return;
                            runBootstrapAction(`delete-member-${member.id}`, () => deleteMember(settings.competition_id, member.id), `${member.username} 已删除。`);
                          }}
                        >
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="admin-neo-empty-cell">暂无成员</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="admin-neo-leaderboard-panel">
          <div className="admin-neo-panel-title">
            <h3><span className="material-symbols-outlined">leaderboard</span> 全局排行榜</h3>
          </div>
          <div className="admin-neo-table-wrap">
            <table className="admin-neo-table admin-neo-leaderboard-table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>队伍名称</th>
                  <th>准确率</th>
                  <th>参数量</th>
                  <th>提交人</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length ? leaderboard.map((entry) => (
                  <tr key={entry.team_id} className={entry.rank === 1 ? 'is-top-row' : ''}>
                    <td className="admin-neo-rank-cell">#{String(entry.rank).padStart(2, '0')}</td>
                    <td className="is-strong">{entry.team_name}</td>
                    <td className={entry.rank === 1 ? 'is-primary' : ''}>{formatPercent(entry.accuracy)}</td>
                    <td className="is-secondary">{formatCompactNumber(entry.param_count)}</td>
                    <td>{entry.submitted_by}</td>
                    <td className="is-muted">{formatShortStamp(entry.created_at)}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan="6" className="admin-neo-empty-cell">暂无排行榜数据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-neo-feed-section">
          <div className="admin-neo-feed-header">
            <h3><span className="material-symbols-outlined">collections</span> 最新标注</h3>
            <button
              type="button"
              className="admin-neo-feed-button"
              disabled={!settings?.competition_id}
              onClick={() => {
                if (!settings?.competition_id) return;
                runBootstrapAction('refresh-feed', () => fetchAdminBootstrap(settings.competition_id), '最新标注已刷新。');
              }}
            >
              刷新标注
            </button>
          </div>

          <div className="admin-neo-feed-grid">
            {samples.length ? samples.slice(0, 24).map((sample) => (
              <article key={sample.id} className="admin-neo-feed-card">
                <div className="admin-neo-feed-image">
                  <img src={buildApiUrl(sample.image_url)} alt={`标注样本-${sample.label}`} />
                </div>
                <div className="admin-neo-feed-copy">
                  <div className="admin-neo-feed-team">{sample.team_name}</div>
                  <div className="admin-neo-feed-meta">
                    <span className="admin-neo-feed-tag">标签 {sample.label}</span>
                    <span>{getRelativeAge(sample.created_at)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="admin-neo-feed-delete"
                  disabled={!settings?.competition_id || activeAction === `delete-annotation-${sample.id}`}
                  onClick={() => {
                    if (!window.confirm('确定删除这条标注样本吗？')) return;
                    runBootstrapAction(`delete-annotation-${sample.id}`, () => deleteAnnotation(settings.competition_id, sample.id), '标注样本已删除。');
                  }}
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </article>
            )) : <p className="admin-neo-empty-copy">暂无最新标注</p>}
          </div>
        </section>

        <section className="admin-neo-ops-grid">
          <div className="admin-neo-ops-panel">
            <div className="admin-neo-panel-title">
              <h3><span className="material-symbols-outlined">hub</span> 队伍概况</h3>
            </div>
            <div className="admin-neo-signal-list">
              {teams.slice(0, 6).map((team) => (
                <article key={team.id} className="admin-neo-signal-row">
                  <div>
                    <strong>{team.name}</strong>
                    <span>成员 {team.member_count}/{settings?.team_member_limit || '--'} | 标注 {formatCompactNumber(team.annotation_count)} | 提交 {team.submission_count}</span>
                    <span>最佳 {formatPercent(team.best_accuracy)} | 贡献者 {(teamDetailMap[team.id]?.member_contributions || []).slice(0, 2).map((member) => member.username).join(', ') || '--'}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="admin-neo-ops-panel">
            <div className="admin-neo-panel-title">
              <h3><span className="material-symbols-outlined">inventory_2</span> 提交记录</h3>
            </div>
            <div className="admin-neo-table-wrap">
              <table className="admin-neo-table">
                <thead>
                  <tr>
                    <th>队伍</th>
                    <th>成员</th>
                    <th>准确率</th>
                    <th>参数量</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.slice(0, 8).length ? submissions.slice(0, 8).map((submission) => (
                    <tr key={submission.id}>
                      <td className="is-strong">{submission.team_name}</td>
                      <td>{submission.username}</td>
                      <td className="is-primary">{formatPercent(submission.accuracy)}</td>
                      <td className="is-secondary">{formatCompactNumber(submission.param_count)}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-neo-table-icon is-danger"
                          disabled={!settings?.competition_id || activeAction === `delete-submission-${submission.id}`}
                          onClick={() => {
                            if (!window.confirm('确定删除这条提交记录吗？')) return;
                            runBootstrapAction(`delete-submission-${submission.id}`, () => deleteSubmission(settings.competition_id, submission.id), '提交记录已删除。');
                          }}
                        >
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="admin-neo-empty-cell">暂无提交记录</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      <footer className="admin-neo-footer">
        <div>NEURAL OPS v2.4.0-STABLE</div>
        <div className="admin-neo-footer-right">
          <span>核心温度: 34°C</span>
          <span>READY</span>
          <span className="is-primary">安全会话</span>
        </div>
      </footer>
    </div>
  );
}

export default AdminNeoPage;
