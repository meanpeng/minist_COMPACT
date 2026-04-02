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

function AppChrome({
  activeSection = 'annotation',
  children,
  session,
  onResetExperiment,
  trainingUnlocked = false,
}) {
  const username = session?.user?.username || 'Guest';
  const teamName = session?.team?.name || 'No Team';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <span className="top-bar-title">AI Principle Course</span>
          <span className="top-bar-timer">04:20:59</span>
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

      <div className="app-shell-body">
        <aside className="side-bar">
          <nav className="side-nav">
            {sideNavItems.map((item) => (
              isItemLocked(item.key, trainingUnlocked) ? (
                <button key={item.key} type="button" className="side-nav-item side-nav-item-locked" disabled>
                  <span className="material-symbols-outlined">{item.icon}</span>
                  <span>{item.label}</span>
                  <span className="material-symbols-outlined side-nav-lock">lock</span>
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
            <button type="button" className="experiment-button" onClick={onResetExperiment}>
              NEW_EXPERIMENT
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
            disabled={isItemLocked(item.key, trainingUnlocked)}
            onClick={() => {
              if (isItemLocked(item.key, trainingUnlocked)) {
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
            {isItemLocked(item.key, trainingUnlocked) ? (
              <span className="material-symbols-outlined mobile-nav-lock">lock</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export default AppChrome;
