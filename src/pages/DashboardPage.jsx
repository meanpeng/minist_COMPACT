import { useEffect, useState } from 'react';
import AppChrome from '../components/AppChrome';
import { ApiError, fetchDashboard } from '../lib/api';

const REFRESH_INTERVAL_MS = 5000;

function toDisplayPercent(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function formatTimestamp(value) {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleString();
}

function getLeaderboardVisual(row) {
  if (row.is_current_team) {
    return { accent: 'primary', icon: 'radar' };
  }

  if (row.rank === 1) {
    return { accent: 'gold', icon: 'workspace_premium', iconFilled: true };
  }

  if (row.rank === 2) {
    return { accent: 'neutral', icon: 'stars' };
  }

  if (row.rank === 3) {
    return { accent: 'neutral', icon: 'military_tech' };
  }

  return { accent: 'neutral', icon: 'shield' };
}

function buildRankMeterSegments(rank, totalRankedTeams) {
  if (!rank || !totalRankedTeams) {
    return Array.from({ length: 8 }, () => false);
  }

  const ratio = Math.max(0, Math.min(1, (totalRankedTeams - rank + 1) / totalRankedTeams));
  const activeCount = Math.max(1, Math.round(ratio * 8));
  return Array.from({ length: 8 }, (_, index) => index < activeCount);
}

function buildStatusClass(row) {
  if (row.is_current_team) {
    return 'status-pill status-pill-primary';
  }

  if (row.status === 'Climbing') {
    return 'status-pill status-pill-secondary';
  }

  if (row.status === 'Falling') {
    return 'status-pill status-pill-error';
  }

  return 'status-pill status-pill-neutral';
}

function DashboardPage({
  session,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
  inviteCodeNotice = null,
  onDismissInviteCodeNotice,
  onCompetitionChange,
  competitionTimer,
}) {
  const [dashboard, setDashboard] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    let isActive = true;
    let intervalId = null;

    async function loadDashboard({ silent } = { silent: false }) {
      if (!session?.session_token) {
        if (isActive) {
          setDashboard(null);
          setIsLoading(false);
        }
        return;
      }

      if (!silent) {
        setIsLoading(true);
      }

      try {
        const response = await fetchDashboard(session.session_token);
        if (!isActive) {
          return;
        }

        setDashboard(response);
        setErrorMessage('');
        onCompetitionChange?.(response.competition || null);
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof ApiError ? error.message : '总览数据加载失败。');
      } finally {
        if (isActive && !silent) {
          setIsLoading(false);
        }
      }
    }

    loadDashboard();

    intervalId = window.setInterval(() => {
      loadDashboard({ silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [session?.session_token]);

  useEffect(() => {
    if (!copyStatus) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyStatus('');
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [copyStatus]);

  const annotationStats = dashboard?.annotation_stats;
  const competition = dashboard?.competition;
  const ranking = dashboard?.ranking;
  const latestValidation = dashboard?.latest_validation;
  const leaderboard = dashboard?.leaderboard || [];
  const teamMembers = dashboard?.team_members || [];
  const inviteCode = dashboard?.session?.team?.invite_code || session?.team?.invite_code || '';
  const competitionName = competition?.competition_name || dashboard?.session?.competition?.name || '比赛同步中';
  const teamMemberLimit = competition?.team_member_limit || dashboard?.session?.competition_status?.team_member_limit || session?.competition_status?.team_member_limit || null;
  const distributionBars = annotationStats?.counts_by_label?.length
    ? (() => {
        const maxCount = Math.max(...annotationStats.counts_by_label, 0);
        if (!maxCount) {
          return annotationStats.counts_by_label.map(() => 0);
        }

        return annotationStats.counts_by_label.map((count) => (count / maxCount) * 100);
      })()
    : Array.from({ length: 10 }, () => 0);
  const rankMeterSegments = buildRankMeterSegments(ranking?.rank, ranking?.total_ranked_teams);
  const memberSummary = teamMembers.map((member) => member.username).join(', ') || '等待队员加入';

  const handleCopyInviteCode = async () => {
    if (!inviteCode) {
      return;
    }

    try {
      await window.navigator.clipboard.writeText(inviteCode);
      setCopyStatus('邀请码已复制。');
    } catch {
      setCopyStatus('复制失败，请手动复制。');
    }
  };

  return (
    <AppChrome
      activeSection="dashboard"
      session={session}
      competition={competition}
      competitionTimer={competitionTimer}
      onResetExperiment={onResetExperiment}
      trainingUnlocked={trainingUnlocked}
      isTrainingActive={isTrainingActive}
    >
      <main className="dashboard-main custom-scrollbar">
        <header className="hero-panel">
          <div className="hero-glow" aria-hidden="true" />

          <div className="hero-copy">
            <h1>{competitionName}</h1>
            <div className="hero-meta">
              <span className="hero-phase">{competition ? `LIVE_${competition.effective_status.toUpperCase()}` : 'SYNCING'}</span>
              <span className="hero-separator">//</span>
              <span>{`TEAM ${String(teamMembers.length).padStart(2, '0')} / ${teamMemberLimit || '--'}`}</span>
            </div>
            <p className="hero-member-line">{memberSummary}</p>
          </div>

          <div className="hero-timer-block">
            <p>{competitionTimer?.label || '状态'}</p>
            <div className="hero-timer">{competitionTimer?.value || '--'}</div>
          </div>
        </header>

        <div className="stats-grid">
          <section className="stat-card stat-card-primary invite-card">
            <div className="card-header-row">
              <h3>队伍邀请码</h3>
              <span className="digits-count">{teamMembers.length} <span>/ {teamMemberLimit || '--'} 成员</span></span>
            </div>
            <div className="invite-code-row">
              <span className="invite-code-value">{inviteCode || '--'}</span>
              <button type="button" className="invite-code-copy" onClick={handleCopyInviteCode}>
                <span className="material-symbols-outlined">content_copy</span>
              </button>
            </div>
            <p className="stat-note">{memberSummary}</p>
            {copyStatus ? <p className="terminal-feedback invite-feedback">{copyStatus}</p> : null}
          </section>

          <section className="stat-card stat-card-primary">
            <div className="stat-corner" aria-hidden="true" />
            <h3>队伍排名</h3>
            <div className="stat-rank-row">
              <span className="rank-value">{ranking?.rank ? `#${ranking.rank}` : '--'}</span>
              <span className="rank-total">{`/ ${ranking?.total_ranked_teams || 0}`}</span>
            </div>
            <div className="rank-meter" aria-hidden="true">
              {rankMeterSegments.map((isActive, index) => (
                <div
                  key={index}
                  className={isActive ? 'rank-meter-segment rank-meter-segment-active' : 'rank-meter-segment'}
                />
              ))}
            </div>
            <p className="stat-note">
              {ranking?.rank && ranking?.percentile
                ? `超过 ${Math.max(1, Math.round(ranking.percentile * 100))}% 的队伍`
                : '等待下一次验证'}
            </p>
          </section>

          <section className="stat-card stat-card-secondary">
            <div className="card-header-row">
              <h3>标注分布</h3>
              <span className="digits-count">
                {annotationStats?.total_count?.toLocaleString?.() || '0'} <span>样本</span>
              </span>
            </div>
            <div className="distribution-chart">
              {distributionBars.map((height, index) => (
                <div
                  key={index}
                  className="distribution-bar"
                  title={`数字 ${index}: ${annotationStats?.counts_by_label?.[index] || 0}`}
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            <div className="distribution-labels">
              <span>0</span>
              <span>类别</span>
              <span>9</span>
            </div>
          </section>

          <section className="stat-card stat-card-tertiary">
            <h3>最近一次验证</h3>
            <div className="validation-row">
              <span className="validation-score">{toDisplayPercent(latestValidation?.latest_accuracy)}</span>
              <span className="material-symbols-outlined validation-icon">
                {latestValidation?.latest_accuracy ? 'trending_up' : 'schedule'}
              </span>
            </div>
            <p className="validation-note">
              {latestValidation?.previous_best_accuracy !== null && latestValidation?.previous_best_accuracy !== undefined
                ? `历史最好：${toDisplayPercent(latestValidation.previous_best_accuracy)}`
                : '历史最好：--'}
            </p>
            <div className="validation-log">
              <span>
                {latestValidation?.submitted_by
                  ? `${latestValidation.submitted_by} // ${latestValidation.sample_count || '--'} 个样本`
                  : '还没有新的验证记录'}
              </span>
              <span className="material-symbols-outlined">terminal</span>
            </div>
          </section>
        </div>

        {errorMessage ? <div className="dashboard-banner dashboard-banner-error">{errorMessage}</div> : null}
        {!errorMessage && isLoading ? <div className="dashboard-banner">正在加载比赛总览...</div> : null}
        {!errorMessage && competition?.effective_status === 'not_started' ? (
          <div className="dashboard-banner">赛事尚未开始，提交通道暂未开放。</div>
        ) : null}
        {!errorMessage && competition?.effective_status === 'ended' ? (
          <div className="dashboard-banner">赛事已结束，排行榜已锁定。</div>
        ) : null}
        {!errorMessage && competition && !competition.allow_submission ? (
          <div className="dashboard-banner">提交通道已暂时关闭。</div>
        ) : null}

        <section className="leaderboard-panel">
          <div className="leaderboard-header">
            <h2>
              <span className="material-symbols-outlined leaderboard-icon">leaderboard</span>
              赛事榜
            </h2>
            <span className="leaderboard-status">{`SYNC // ${formatTimestamp(latestValidation?.submitted_at)}`}</span>
          </div>

          <div className="leaderboard-content">
            <table className="leaderboard-table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>队伍</th>
                  <th>最近成绩</th>
                  <th className="align-right">状态</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length ? (
                  leaderboard.map((row) => {
                    const visual = getLeaderboardVisual(row);
                    return (
                      <tr
                        key={`${row.team_id}-${row.rank}`}
                        className={row.is_current_team ? 'leaderboard-row leaderboard-row-active' : 'leaderboard-row'}
                      >
                        <td className={`rank-cell rank-cell-${visual.accent}`}>
                          <span className={`rank-text rank-text-${visual.accent}`}>{String(row.rank).padStart(2, '0')}</span>
                        </td>
                        <td>
                          <div className="team-cell">
                            <div className={`team-icon-box team-icon-box-${visual.accent}`}>
                              <span
                                className={`material-symbols-outlined team-icon team-icon-${visual.accent}`}
                                style={
                                  visual.iconFilled
                                    ? { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }
                                    : undefined
                                }
                              >
                                {visual.icon}
                              </span>
                            </div>
                            <div className="team-copy">
                              <span className={row.is_current_team ? 'team-name-text team-name-highlight' : 'team-name-text'}>
                                {row.team_name}
                              </span>
                              <span className="team-members-text">
                                {row.member_names.length ? row.member_names.join(', ') : '暂无成员'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className="accuracy-text">{toDisplayPercent(row.accuracy)}</span>
                        </td>
                        <td className="align-right">
                          <span className={buildStatusClass(row)}>{row.status}</span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr className="leaderboard-row">
                    <td colSpan="4" className="leaderboard-empty-cell">
                      还没有队伍上榜，先提交一次验证结果吧。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {inviteCodeNotice ? (
        <div className="terminal-modal-backdrop" role="presentation">
          <div className="terminal-modal arcade-shadow-primary" role="dialog" aria-modal="true">
            <div className="terminal-modal-header">
              <div>
                <p className="terminal-modal-kicker">TEAM READY</p>
                <h3>通行码已生成</h3>
              </div>
              <button
                type="button"
                className="terminal-modal-close"
                onClick={onDismissInviteCodeNotice}
                aria-label="关闭邀请码提示"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <p className="terminal-modal-copy">把这串通行码发给队友，他们输入后即可加入你的队伍。</p>
            <div className="invite-code-row invite-code-row-modal">
              <span className="invite-code-value">{inviteCodeNotice}</span>
              <button type="button" className="invite-code-copy" onClick={handleCopyInviteCode}>
                <span className="material-symbols-outlined">content_copy</span>
              </button>
            </div>

            <div className="terminal-modal-actions">
              <button type="button" className="arcade-button arcade-button-primary" onClick={onDismissInviteCodeNotice}>
                进入比赛面板
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppChrome>
  );
}

export default DashboardPage;
