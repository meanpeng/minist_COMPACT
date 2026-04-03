const sideNavItems = [
  { icon: 'dashboard', label: '总览', key: 'dashboard' },
  { icon: 'edit_note', label: '标注', key: 'annotation', filled: true },
  { icon: 'extension', label: '模型', key: 'modeling' },
  { icon: 'analytics', label: '训练', key: 'training' },
  { icon: 'verified', label: '提交', key: 'submission' },
];

const mobileNavItems = [
  { icon: 'dashboard', label: '总览', key: 'dashboard' },
  { icon: 'edit_note', label: '标注', key: 'annotation', filled: true },
  { icon: 'extension', label: '模型', key: 'modeling' },
  { icon: 'analytics', label: '训练', key: 'training' },
  { icon: 'verified', label: '提交', key: 'submission', filled: true },
];

function getRouteHref(key) {
  return `#${key}`;
}

function isItemLocked(itemKey, trainingUnlocked) {
  return (itemKey === 'training' || itemKey === 'submission') && !trainingUnlocked;
}

function isNavigationBlocked(itemKey, activeSection, isTrainingActive) {
  return isTrainingActive && itemKey !== activeSection;
}

function AppChrome({
  activeSection = 'annotation',
  children,
  session,
  competition = null,
  competitionTimer = { label: '状态', value: '--' },
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
}) {
  const username = session?.user?.username || '访客';
  const teamName = session?.team?.name || '未加入队伍';

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <span className="top-bar-title">模王巅峰赛 · MODEL KING PEAK</span>
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
          <span>训练进行中，切换页面和重新开始会暂时锁定。</span>
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
              {isTrainingActive ? 'LIVE LOCK' : '重新开始比赛'}
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
