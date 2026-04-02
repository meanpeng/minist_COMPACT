const sideNavItems = [
  { icon: 'dashboard', label: 'Dashboard', key: 'dashboard' },
  { icon: 'edit_note', label: 'Annotation', key: 'annotation', filled: true },
  { icon: 'extension', label: 'Modeling', key: 'modeling' },
  { icon: 'analytics', label: 'Training', key: 'training' },
  { icon: 'verified', label: 'Submission', key: 'submission' },
];

const mobileNavItems = [
  { icon: 'dashboard', label: 'DASH', key: 'dashboard' },
  { icon: 'edit_note', label: 'ANNOTATE', key: 'annotation', filled: true },
  { icon: 'extension', label: 'MODEL', key: 'modeling' },
  { icon: 'analytics', label: 'TRAIN', key: 'training' },
  { icon: 'verified', label: 'DONE', key: 'submission', filled: true },
];

function getRouteHref(key) {
  return `#${key}`;
}

function isItemLocked(itemKey, trainingUnlocked) {
  return itemKey === 'training' && !trainingUnlocked;
}

function isNavigationBlocked(itemKey, activeSection, isTrainingActive) {
  return isTrainingActive && itemKey !== activeSection;
}

function formatDuration(totalSeconds) {
  if (typeof totalSeconds !== 'number' || Number.isNaN(totalSeconds) || totalSeconds < 0) {
    return '--';
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}D ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildCompetitionTimer(competition) {
  if (!competition) {
    return { label: 'STATUS', value: '--' };
  }

  if (competition.effective_status === 'not_started') {
    return {
      label: 'STARTS IN',
      value: competition.seconds_until_start != null ? formatDuration(competition.seconds_until_start) : 'NOT_STARTED',
    };
  }

  if (competition.effective_status === 'ended') {
    return { label: 'STATUS', value: 'ENDED' };
  }

  if (!competition.end_time) {
    return { label: 'STATUS', value: 'IN_PROGRESS' };
  }

  return {
    label: 'TIME LEFT',
    value: competition.seconds_until_end != null ? formatDuration(competition.seconds_until_end) : 'IN_PROGRESS',
  };
}

function AppChrome({
  activeSection = 'annotation',
  children,
  session,
  competition = null,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
}) {
  const username = session?.user?.username || 'Guest';
  const teamName = session?.team?.name || 'No Team';
  const competitionTimer = buildCompetitionTimer(competition);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <span className="top-bar-title">AI Principle Course</span>
          <span className="top-bar-timer">{`${competitionTimer.label}: ${competitionTimer.value}`}</span>
        </div>

        <div className="top-bar-right">
          <div className="user-status">
            <span className="user-name">{username}</span>
            <span className="team-name">{teamName}</span>
          </div>
          <div className="avatar-frame">
            <span className="material-symbols-outlined avatar-icon">account_circle</span>
          </div>
        </div>
      </header>

      {isTrainingActive ? (
        <div className="training-lock-banner" role="status" aria-live="polite">
          <span className="material-symbols-outlined">hourglass_top</span>
          <span>TRAINING IN PROGRESS. OTHER TABS AND RESET ARE TEMPORARILY LOCKED UNTIL THIS RUN FINISHES.</span>
        </div>
      ) : null}

      <div className="app-shell-body">
        <aside className="side-bar">
          <nav className="side-nav">
            {sideNavItems.map((item) => (
              isItemLocked(item.key, trainingUnlocked) || isNavigationBlocked(item.key, activeSection, isTrainingActive) ? (
                <button key={item.key} type="button" className="side-nav-item side-nav-item-locked" disabled>
                  <span className="material-symbols-outlined">{item.icon}</span>
                  <span>{item.label}</span>
                  <span className="material-symbols-outlined side-nav-lock">
                    {isTrainingActive ? 'hourglass_top' : 'lock'}
                  </span>
                </button>
              ) : (
                <a
                  key={item.key}
                  href={getRouteHref(item.key)}
                  className={
                    activeSection === item.key ? 'side-nav-item side-nav-item-active' : 'side-nav-item'
                  }
                >
                  <span
                    className="material-symbols-outlined"
                    style={
                      item.filled && activeSection === item.key
                        ? { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }
                        : undefined
                    }
                  >
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </a>
              )
            ))}
          </nav>

          <div className="side-footer">
            <button type="button" className="experiment-button" onClick={onResetExperiment} disabled={isTrainingActive}>
              {isTrainingActive ? 'TRAINING_LOCKED' : 'NEW_EXPERIMENT'}
            </button>
          </div>
        </aside>

        <div className="app-content">{children}</div>
      </div>

      <div className="mobile-bottom-nav">
        {mobileNavItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={
              activeSection === item.key ? 'mobile-nav-item mobile-nav-item-active' : 'mobile-nav-item'
            }
            disabled={
              isItemLocked(item.key, trainingUnlocked) || isNavigationBlocked(item.key, activeSection, isTrainingActive)
            }
            onClick={() => {
              if (
                isItemLocked(item.key, trainingUnlocked) ||
                isNavigationBlocked(item.key, activeSection, isTrainingActive)
              ) {
                return;
              }
              window.location.hash = item.key;
            }}
          >
            <span
              className="material-symbols-outlined"
              style={
                item.filled && activeSection === item.key
                  ? { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }
                  : undefined
              }
            >
              {item.icon}
            </span>
            <span>{item.label}</span>
            {isItemLocked(item.key, trainingUnlocked) || isNavigationBlocked(item.key, activeSection, isTrainingActive) ? (
              <span className="material-symbols-outlined mobile-nav-lock">lock</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export default AppChrome;
