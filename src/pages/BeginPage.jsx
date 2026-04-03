import { useEffect, useMemo, useState } from 'react';
import { ApiError, checkServerHealth, createTeam, fetchCompetitions, joinTeam } from '../lib/api';

function BeginPage({ onSessionReady, session }) {
  const [competitions, setCompetitions] = useState([]);
  const [username, setUsername] = useState(session?.user?.username || '');
  const [teamName, setTeamName] = useState('');
  const [joinInviteCode, setJoinInviteCode] = useState('');
  const [activeAction, setActiveAction] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [serverStatus, setServerStatus] = useState('checking');
  const hasActiveTeamSession = Boolean(session?.user?.id && session?.team?.id);

  useEffect(() => {
    let isActive = true;

    const updateServerStatus = async () => {
      try {
        await checkServerHealth();
        if (isActive) {
          setServerStatus('online');
        }
      } catch {
        if (isActive) {
          setServerStatus('offline');
        }
      }
    };

    updateServerStatus();
    const intervalId = window.setInterval(updateServerStatus, 10000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    fetchCompetitions()
      .then((rows) => {
        if (!isActive) {
          return;
        }
        setCompetitions(rows);
      })
      .catch(() => {
        if (isActive) {
          setCompetitions([]);
        }
      });

    return () => {
      isActive = false;
    };
  }, [session?.competition?.id]);

  const selectedCompetition = useMemo(() => competitions[0] || null, [competitions]);
  const selectedCompetitionId = selectedCompetition?.id || '';

  const locationLabel =
    serverStatus === 'online'
      ? '服务已连接'
      : serverStatus === 'offline'
        ? '服务未连接'
        : '服务检测中';

  const validateCommonFields = () => {
    if (hasActiveTeamSession) {
      setErrorMessage(`你已经加入 ${session.team.name}，若要切换队伍请先重新开始。`);
      return false;
    }

    if (!selectedCompetitionId) {
      setErrorMessage('当前没有可加入的比赛，请先联系老师。');
      return false;
    }

    if (!username.trim()) {
      setErrorMessage('请先输入用户名。');
      return false;
    }

    return true;
  };

  const submitCreateTeam = async () => {
    if (!validateCommonFields()) {
      return;
    }

    if (!teamName.trim()) {
      setErrorMessage('请输入队伍名称。');
      return;
    }

    setActiveAction('create');
    setErrorMessage('');

    try {
      const nextSession = await createTeam({
        competition_id: selectedCompetitionId,
        username: username.trim(),
        team_name: teamName.trim(),
      });
      onSessionReady(nextSession, { showInviteCodeNotice: true });
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '暂时无法创建队伍。');
    } finally {
      setActiveAction('');
    }
  };

  const submitJoinTeam = async () => {
    if (!validateCommonFields()) {
      return;
    }

    if (!joinInviteCode.trim()) {
      setErrorMessage('请输入邀请码。');
      return;
    }

    setActiveAction('join');
    setErrorMessage('');

    try {
      const nextSession = await joinTeam({
        competition_id: selectedCompetitionId,
        username: username.trim(),
        invite_code: joinInviteCode.trim(),
      });
      onSessionReady(nextSession);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '暂时无法加入队伍。');
    } finally {
      setActiveAction('');
    }
  };

  return (
    <>
      <div className="scanline-overlay" aria-hidden="true" />
      <div className="dot-grid-overlay" aria-hidden="true" />

      <main className="begin-page">
        <div className="begin-shell">
          <div className="brand-accent">
            <span className="material-symbols-outlined brand-icon">terminal</span>
            <span>MODEL KING</span>
          </div>

          <div className="terminal-frame arcade-shadow">
            <div className="terminal-panel">
              <header className="terminal-header">
                <div>
                  <h1 className="terminal-title">模王巅峰赛</h1>
                  <p className="terminal-status">MODEL KING PEAK // READY TO PLAY</p>
                </div>

                <div className={`terminal-location terminal-location-${serverStatus}`}>
                  <div className="terminal-location-pulse" />
                  <span>{locationLabel}</span>
                </div>
              </header>

              <section className="login-section">
                <div className="section-title-row">
                  <span className="step-badge step-badge-primary">STEP_01</span>
                  <h2>本场赛事</h2>
                </div>

                <div className="competition-display-card">
                  <div className="competition-display-name">
                    {selectedCompetition ? selectedCompetition.name : '暂无赛事'}
                  </div>
                  <p className="terminal-feedback">
                    {selectedCompetition
                      ? '系统会自动匹配当前赛事，组队完成后即可进入。'
                      : '当前没有进行中的赛事，请先联系管理员。'}
                  </p>
                </div>

                <div className="section-title-row begin-section-gap">
                  <span className="step-badge step-badge-secondary">STEP_02</span>
                  <h2>加入比赛</h2>
                </div>

                <div className="field-group">
                  <div className="field-icon-wrap">
                    <span className="material-symbols-outlined">person</span>
                  </div>
                  <input
                    className="terminal-input terminal-input-lg terminal-input-primary"
                    placeholder="输入昵称"
                    type="text"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                  <div className="input-progress-track" aria-hidden="true">
                    <div className="input-progress-bar" />
                  </div>
                </div>
                {errorMessage ? <p className="terminal-feedback terminal-feedback-error">{errorMessage}</p> : null}
                {hasActiveTeamSession ? (
                  <div className="terminal-session-lock">
                    <div className="terminal-session-lock-header">
                      <span className="material-symbols-outlined">shield_lock</span>
                      <strong>检测到已有队伍会话</strong>
                    </div>
                    <p>{`${session.user.username} 已加入 ${session.team.name}，当前属于 ${session.competition?.name || '本场比赛'}。`}</p>
                    <button
                      type="button"
                      className="arcade-button arcade-button-primary terminal-session-lock-button"
                      onClick={() => {
                        window.location.hash = 'dashboard';
                      }}
                    >
                      返回总览
                    </button>
                  </div>
                ) : null}
              </section>

              <section>
                <div className="command-grid">
              <div className="command-card command-card-primary">
                    <div className="command-heading">
                      <span className="material-symbols-outlined command-icon-primary">group</span>
                      <h3>创建队伍</h3>
                    </div>

                    <p>集结队友开练！标注数据、模型战绩一键同步</p>

                    <div className="command-actions">
                      <input
                        className="terminal-input terminal-input-primary"
                        placeholder="队伍名称"
                        type="text"
                        value={teamName}
                        onChange={(event) => setTeamName(event.target.value)}
                        disabled={hasActiveTeamSession}
                      />
                      <button
                        type="button"
                        className="arcade-button arcade-button-primary"
                        onClick={submitCreateTeam}
                        disabled={activeAction === 'create' || hasActiveTeamSession || !selectedCompetitionId}
                      >
                        {activeAction === 'create' ? '组队中...' : '创建队伍'}
                      </button>
                    </div>

                    <div className="card-corner card-corner-primary" aria-hidden="true" />
                  </div>

                  <div className="command-card command-card-secondary">
                    <div className="command-heading">
                      <span className="material-symbols-outlined command-icon-secondary">workspace_premium</span>
                      <h3>加入队伍</h3>
                    </div>

                    <p>填写专属邀请码即可入伙组队</p>

                    <div className="command-actions">
                      <input
                        className="terminal-input terminal-input-secondary"
                        placeholder="输入邀请码"
                        type="text"
                        value={joinInviteCode}
                        onChange={(event) => setJoinInviteCode(event.target.value.toUpperCase())}
                        disabled={hasActiveTeamSession}
                      />

                      <button
                        type="button"
                        className="arcade-button arcade-button-secondary"
                        onClick={submitJoinTeam}
                        disabled={activeAction === 'join' || hasActiveTeamSession || !selectedCompetitionId}
                      >
                        {activeAction === 'join' ? '匹配中...' : '加入队伍'}
                      </button>
                    </div>

                    <div className="card-corner card-corner-secondary" aria-hidden="true" />
                  </div>
                </div>
              </section>

              <footer className="terminal-footer">
                <div className="footer-stats">
                  <div className="footer-stat">
                    <span>赛事数</span>
                    <strong className="text-primary">{String(competitions.length).padStart(2, '0')}</strong>
                  </div>
                  <div className="footer-stat">
                    <span>状态</span>
                    <strong className="text-secondary">{selectedCompetition ? 'READY' : 'WAITING'}</strong>
                  </div>
                </div>

                <div className="footer-meta">2026 MODEL KING // 模王就是你！// MeanPeng</div>
                <div className="footer-meta">参赛入口 // Invite Code</div>
              </footer>
            </div>
          </div>

          <div className="background-label" aria-hidden="true">
            <span>READY</span>
          </div>
          <div className="pixel-accent pixel-accent-left" aria-hidden="true" />
          <div className="pixel-accent pixel-accent-right" aria-hidden="true" />
        </div>
      </main>
    </>
  );
}

export default BeginPage;
