import { useEffect, useState } from 'react';
import AdminPage from './pages/AdminPage';
import AdminNeoPage from './pages/AdminNeoPage';
import AnnotationPage from './pages/AnnotationPage';
import BeginPage from './pages/BeginPage';
import DashboardPage from './pages/DashboardPage';
import ModelingPage from './pages/ModelingPage';
import SubmissionPage from './pages/SubmissionPage';
import TrainingPage from './pages/TrainingPage';
import { fetchAnnotationStats, fetchSession } from './lib/api';
import {
  clearStoredAnnotationStats,
  clearStoredSession,
  loadStoredAnnotationStats,
  loadStoredSession,
  saveStoredAnnotationStats,
  saveStoredSession,
} from './lib/session';

const DEFAULT_ROUTE = 'begin';
const VALID_ROUTES = new Set(['begin', 'dashboard', 'annotation', 'modeling', 'training', 'submission', 'admin', 'admin-v2']);

function areAnnotationStatsEqual(currentStats, nextStats) {
  if (!currentStats || !nextStats) {
    return currentStats === nextStats;
  }

  return (
    currentStats.team_id === nextStats.team_id &&
    currentStats.total_count === nextStats.total_count &&
    currentStats.goal === nextStats.goal &&
    currentStats.remaining_to_goal === nextStats.remaining_to_goal &&
    currentStats.progress_ratio === nextStats.progress_ratio &&
    currentStats.counts_by_label.length === nextStats.counts_by_label.length &&
    currentStats.counts_by_label.every((count, index) => count === nextStats.counts_by_label[index])
  );
}

function getRouteFromHash() {
  const route = window.location.hash.replace('#', '').trim().toLowerCase();
  return VALID_ROUTES.has(route) ? route : DEFAULT_ROUTE;
}

function App() {
  const [route, setRoute] = useState(() => getRouteFromHash());
  const [session, setSession] = useState(() => loadStoredSession());
  const [isBootstrapping, setIsBootstrapping] = useState(() => Boolean(loadStoredSession()?.session_token));
  const [annotationStats, setAnnotationStats] = useState(() => loadStoredAnnotationStats());
  const [isAnnotationStatsLoading, setIsAnnotationStatsLoading] = useState(false);
  const [inviteCodeNotice, setInviteCodeNotice] = useState(null);
  const [isTrainingActive, setIsTrainingActive] = useState(false);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', `#${DEFAULT_ROUTE}`);
    }

    const handleHashChange = () => {
      if (isTrainingActive && getRouteFromHash() !== 'training') {
        window.history.replaceState(null, '', '#training');
        setRoute('training');
        return;
      }

      setRoute(getRouteFromHash());
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [isTrainingActive]);

  useEffect(() => {
    if (!session?.session_token) {
      setAnnotationStats(null);
      clearStoredAnnotationStats();
      setIsBootstrapping(false);
      return;
    }

    let isActive = true;
    setIsBootstrapping(true);

    fetchSession(session.session_token)
      .then((freshSession) => {
        if (!isActive) {
          return;
        }

        setSession(freshSession);
        saveStoredSession(freshSession);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        clearStoredSession();
        clearStoredAnnotationStats();
        setSession(null);
        window.location.hash = 'begin';
      })
      .finally(() => {
        if (isActive) {
          setIsBootstrapping(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [session?.session_token]);

  useEffect(() => {
    if (!session?.session_token) {
      setAnnotationStats(null);
      setIsAnnotationStatsLoading(false);
      clearStoredAnnotationStats();
      return undefined;
    }

    let isActive = true;

    const loadAnnotationStats = async ({ silent } = { silent: false }) => {
      if (!silent) {
        setIsAnnotationStatsLoading(true);
      }

      try {
        const nextStats = await fetchAnnotationStats(session.session_token);
        if (isActive) {
          setAnnotationStats((currentStats) => {
            if (areAnnotationStatsEqual(currentStats, nextStats)) {
              return currentStats;
            }

            saveStoredAnnotationStats(nextStats);
            return nextStats;
          });
        }
      } catch {
        // Keep the last successful stats so training unlock state does not flicker
        // across route changes or transient backend delays.
      } finally {
        if (isActive && !silent) {
          setIsAnnotationStatsLoading(false);
        }
      }
    };

    loadAnnotationStats();
    const intervalId = window.setInterval(() => {
      loadAnnotationStats({ silent: true });
    }, 5000);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [session?.session_token]);

  useEffect(() => {
    if (!isBootstrapping && !session && route !== 'begin' && route !== 'admin' && route !== 'admin-v2') {
      window.location.hash = 'begin';
    }
  }, [isBootstrapping, route, session]);

  const isTrainingUnlocked =
    Boolean(annotationStats) && annotationStats.total_count >= annotationStats.goal;

  useEffect(() => {
    if (!isBootstrapping && route === 'training' && session && annotationStats && !isTrainingUnlocked) {
      window.location.hash = 'annotation';
    }
  }, [annotationStats, isBootstrapping, isTrainingUnlocked, route, session]);

  useEffect(() => {
    if (isTrainingActive && route !== 'training') {
      window.history.replaceState(null, '', '#training');
      setRoute('training');
    }
  }, [isTrainingActive, route]);

  const handleSessionReady = (nextSession, options = {}) => {
    setSession(nextSession);
    saveStoredSession(nextSession);
    setInviteCodeNotice(options.showInviteCodeNotice ? nextSession?.team?.invite_code || null : null);
    window.location.hash = 'dashboard';
  };

  const handleResetExperiment = () => {
    clearStoredSession();
    clearStoredAnnotationStats();
    setSession(null);
    setAnnotationStats(null);
    setInviteCodeNotice(null);
    window.location.hash = 'begin';
  };

  if (isBootstrapping) {
    return null;
  }

  if (route === 'begin') {
    return <BeginPage onSessionReady={handleSessionReady} session={session} />;
  }

  if (route === 'admin') {
    return <AdminPage />;
  }

  if (route === 'admin-v2') {
    return <AdminNeoPage />;
  }

  if (route === 'annotation') {
    return (
      <AnnotationPage
        session={session}
        onResetExperiment={handleResetExperiment}
        trainingUnlocked={isTrainingUnlocked}
        isTrainingActive={isTrainingActive}
        stats={annotationStats}
        isStatsLoading={isAnnotationStatsLoading}
        onAnnotationStatsChange={(nextStats) => {
          setAnnotationStats((currentStats) => {
            if (areAnnotationStatsEqual(currentStats, nextStats)) {
              return currentStats;
            }

            saveStoredAnnotationStats(nextStats);
            return nextStats;
          });
        }}
      />
    );
  }

  if (route === 'modeling') {
    return (
      <ModelingPage
        session={session}
        onResetExperiment={handleResetExperiment}
        trainingUnlocked={isTrainingUnlocked}
        isTrainingActive={isTrainingActive}
      />
    );
  }

  if (route === 'training') {
    return (
      <TrainingPage
        session={session}
        onResetExperiment={handleResetExperiment}
        trainingUnlocked={isTrainingUnlocked}
        isTrainingActive={isTrainingActive}
        onTrainingStateChange={setIsTrainingActive}
      />
    );
  }

  if (route === 'submission') {
    return (
      <SubmissionPage
        session={session}
        onResetExperiment={handleResetExperiment}
        trainingUnlocked={isTrainingUnlocked}
        isTrainingActive={isTrainingActive}
      />
    );
  }

  return (
    <DashboardPage
      session={session}
      onResetExperiment={handleResetExperiment}
      trainingUnlocked={isTrainingUnlocked}
      isTrainingActive={isTrainingActive}
      inviteCodeNotice={inviteCodeNotice}
      onDismissInviteCodeNotice={() => setInviteCodeNotice(null)}
    />
  );
}

export default App;
