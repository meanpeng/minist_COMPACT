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
      ? 'SERVER: CONNECTED'
      : serverStatus === 'offline'
        ? 'SERVER: DISCONNECTED'
        : 'SERVER: CHECKING';

  const validateCommonFields = () => {
    if (hasActiveTeamSession) {
      setErrorMessage(`You have already joined ${session.team.name}. Start a new experiment first if you want to switch teams.`);
      return false;
    }

    if (!selectedCompetitionId) {
      setErrorMessage('No active competition is available right now. Please contact the teacher first.');
      return false;
    }

    if (!username.trim()) {
      setErrorMessage('Please enter a username first.');
      return false;
    }

    return true;
  };

  const submitCreateTeam = async () => {
    if (!validateCommonFields()) {
      return;
    }

    if (!teamName.trim()) {
      setErrorMessage('Please enter a team name.');
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
      setErrorMessage(error instanceof ApiError ? error.message : 'Unable to create team right now.');
    } finally {
      setActiveAction('');
    }
  };

  const submitJoinTeam = async () => {
    if (!validateCommonFields()) {
      return;
    }

    if (!joinInviteCode.trim()) {
      setErrorMessage('Please enter the invite code.');
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
      setErrorMessage(error instanceof ApiError ? error.message : 'Unable to join team right now.');
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
          <div className="begin-admin-entry">
            <a href="#admin" className="begin-admin-link">
              Teacher Admin
            </a>
            <a href="#admin-v2" className="begin-admin-link begin-admin-link-alt">
              Teacher Admin V2
            </a>
          </div>

          <div className="brand-accent">
            <span className="material-symbols-outlined brand-icon">terminal</span>
            <span>BITLAB QUEST</span>
          </div>

          <div className="terminal-frame arcade-shadow">
            <div className="terminal-panel">
              <header className="terminal-header">
                <div>
                  <h1 className="terminal-title">AI_PRINCIPLES_COURSE</h1>
                  <p className="terminal-status">TERMINAL STATUS: ONLINE // SYSTEM READY</p>
                </div>

                <div className={`terminal-location terminal-location-${serverStatus}`}>
                  <div className="terminal-location-pulse" />
                  <span>{locationLabel}</span>
                </div>
              </header>

              <section className="login-section">
                <div className="section-title-row">
                  <span className="step-badge step-badge-primary">STEP_01</span>
                  <h2>CURRENT_COMPETITION</h2>
                </div>

                <div className="competition-display-card">
                  <div className="competition-display-label">RUNNING_MATCH</div>
                  <div className="competition-display-name">
                    {selectedCompetition ? selectedCompetition.name : 'NO_COMPETITION_AVAILABLE'}
                  </div>
                  <p className="terminal-feedback">
                    {selectedCompetition
                      ? 'Competition is assigned automatically. You can continue directly to team setup.'
                      : 'No running competition is available right now. Please contact the teacher before continuing.'}
                  </p>
                </div>

                <div className="section-title-row begin-section-gap">
                  <span className="step-badge step-badge-secondary">STEP_02</span>
                  <h2>ENTER_AND_JOIN</h2>
                </div>

                <div className="field-group">
                  <div className="field-icon-wrap">
                    <span className="material-symbols-outlined">person</span>
                  </div>
                  <input
                    className="terminal-input terminal-input-lg terminal-input-primary"
                    placeholder="ENTER_USERNAME"
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
                      <strong>ACTIVE_TEAM_SESSION_DETECTED</strong>
                    </div>
                    <p>{`${session.user.username} is already assigned to ${session.team.name} in ${session.competition?.name || 'this competition'}.`}</p>
                    <button
                      type="button"
                      className="arcade-button arcade-button-primary terminal-session-lock-button"
                      onClick={() => {
                        window.location.hash = 'dashboard';
                      }}
                    >
                      RETURN_TO_DASHBOARD
                    </button>
                  </div>
                ) : null}
              </section>

              <section>
                <div className="command-grid">
                  <div className="command-card command-card-primary">
                    <div className="command-heading">
                      <span className="material-symbols-outlined command-icon-primary">group</span>
                      <h3>INITIATE_SQUAD</h3>
                    </div>

                    <p>
                      Create a new team in the current competition. Teams, members, annotations and rankings
                      are bound to this match automatically.
                    </p>

                    <div className="command-actions">
                      <input
                        className="terminal-input terminal-input-primary"
                        placeholder="NEW_SQUAD_NAME"
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
                        {activeAction === 'create' ? 'CREATING...' : 'CREATE_COMMAND_UNIT'}
                      </button>
                    </div>

                    <div className="card-corner card-corner-primary" aria-hidden="true" />
                  </div>

                  <div className="command-card command-card-secondary">
                    <div className="command-heading">
                      <span className="material-symbols-outlined command-icon-secondary">workspace_premium</span>
                      <h3>JOIN_ALLIANCE</h3>
                    </div>

                    <p>
                      Join an existing team in the current competition directly with the invite code.
                      The system will match the target team automatically.
                    </p>

                    <div className="command-actions">
                      <input
                        className="terminal-input terminal-input-secondary"
                        placeholder="ENTER_INVITE_CODE"
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
                        {activeAction === 'join' ? 'JOINING...' : 'JOIN_WITH_INVITE_CODE'}
                      </button>
                    </div>

                    <div className="card-corner card-corner-secondary" aria-hidden="true" />
                  </div>
                </div>
              </section>

              <footer className="terminal-footer">
                <div className="footer-stats">
                  <div className="footer-stat">
                    <span>Competitions</span>
                    <strong className="text-primary">{String(competitions.length).padStart(2, '0')}</strong>
                  </div>
                  <div className="footer-stat">
                    <span>Status</span>
                    <strong className="text-secondary">{selectedCompetition ? 'READY' : 'BLOCKED'}</strong>
                  </div>
                </div>

                <div className="footer-meta">2026 BITLAB_CORP // AUTO_MATCH_BINDING</div>
                <div className="footer-meta">STUDENT_ENTRY // DIRECT_INVITE_JOIN</div>
              </footer>
            </div>
          </div>

          <div className="background-label" aria-hidden="true">
            <span>LOGIN_SEQUENCE</span>
          </div>
          <div className="pixel-accent pixel-accent-left" aria-hidden="true" />
          <div className="pixel-accent pixel-accent-right" aria-hidden="true" />
        </div>
      </main>
    </>
  );
}

export default BeginPage;
