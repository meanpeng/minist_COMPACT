import { useEffect, useMemo, useState } from 'react';
import { ApiError, checkServerHealth, createTeam, fetchCompetitions, joinTeam } from '../lib/api';

function BeginPage({ onSessionReady, session }) {
  const [competitions, setCompetitions] = useState([]);
  const [username, setUsername] = useState(session?.user?.username || '');
  const [teamName, setTeamName] = useState('');
  const [joinTeamName, setJoinTeamName] = useState('');
  const [joinInviteCode, setJoinInviteCode] = useState('');
  const [isJoinInvitePromptOpen, setIsJoinInvitePromptOpen] = useState(false);
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

  const openJoinInvitePrompt = () => {
    if (!validateCommonFields()) {
      return;
    }

    if (!joinTeamName.trim()) {
      setErrorMessage('Please enter a team name.');
      return;
    }

    setJoinInviteCode('');
    setErrorMessage('');
    setIsJoinInvitePromptOpen(true);
  };

  const submitJoinTeam = async () => {
    if (!joinInviteCode.trim()) {
      setErrorMessage('Please enter the invite code for this team.');
      return;
    }

    setActiveAction('join');
    setErrorMessage('');

    try {
      const nextSession = await joinTeam({
        competition_id: selectedCompetitionId,
        username: username.trim(),
        team_name: joinTeamName.trim(),
        invite_code: joinInviteCode.trim(),
      });
      setIsJoinInvitePromptOpen(false);
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
                      Join an existing team in the current competition. Team lookup and invite codes are matched
                      against this competition automatically.
                    </p>

                    <div className="command-actions">
                      <div className="search-wrap">
                        <input
                          className="terminal-input terminal-input-secondary"
                          placeholder="SEARCH_TEAM_NAME"
                          type="text"
                          value={joinTeamName}
                          onChange={(event) => setJoinTeamName(event.target.value)}
                          disabled={hasActiveTeamSession}
                        />
                        <span className="material-symbols-outlined search-icon">search</span>
                      </div>

                      <button
                        type="button"
                        className="arcade-button arcade-button-secondary"
                        onClick={openJoinInvitePrompt}
                        disabled={activeAction === 'join' || hasActiveTeamSession || !selectedCompetitionId}
                      >
                        {activeAction === 'join' ? 'VERIFYING...' : 'NEXT_ENTER_INVITE_CODE'}
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
                <div className="footer-meta">STUDENT_ENTRY // TWO_STEP_FLOW</div>
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

      {isJoinInvitePromptOpen ? (
        <div className="terminal-modal-backdrop" role="presentation">
          <div className="terminal-modal arcade-shadow-secondary" role="dialog" aria-modal="true">
            <div className="terminal-modal-header">
              <div>
                <p className="terminal-modal-kicker">TEAM VERIFICATION</p>
                <h3>ENTER_INVITE_CODE</h3>
              </div>
              <button
                type="button"
                className="terminal-modal-close"
                onClick={() => setIsJoinInvitePromptOpen(false)}
                disabled={activeAction === 'join'}
                aria-label="Close invite code dialog"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <p className="terminal-modal-copy">
              {`TARGET_COMPETITION // ${(selectedCompetition?.name || '').toUpperCase()}`}
            </p>

            <p className="terminal-modal-copy">
              {`TARGET_TEAM // ${joinTeamName.trim().toUpperCase()}`}
            </p>

            <input
              className="terminal-input terminal-input-secondary terminal-modal-input"
              placeholder="ENTER_INVITE_CODE"
              type="text"
              value={joinInviteCode}
              onChange={(event) => setJoinInviteCode(event.target.value.toUpperCase())}
            />

            <div className="terminal-modal-actions">
              <button
                type="button"
                className="arcade-button arcade-button-secondary"
                onClick={submitJoinTeam}
                disabled={activeAction === 'join'}
              >
                {activeAction === 'join' ? 'JOINING...' : 'CONFIRM_AND_JOIN'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default BeginPage;
