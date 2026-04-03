import { useEffect, useMemo, useState } from 'react';
import { formatDuration, getCompetitionTimerSnapshot } from '../lib/competitionTimer';

export function useCompetitionTimer(competition) {
  const snapshot = useMemo(() => getCompetitionTimerSnapshot(competition), [competition]);
  const [liveCountdownSeconds, setLiveCountdownSeconds] = useState(snapshot.countdownSeconds);

  useEffect(() => {
    setLiveCountdownSeconds(snapshot.countdownSeconds);
  }, [snapshot.timerKey, snapshot.countdownSeconds]);

  useEffect(() => {
    if (snapshot.countdownSeconds == null) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setLiveCountdownSeconds((currentSeconds) => {
        if (currentSeconds == null || currentSeconds <= 0) {
          return currentSeconds;
        }

        return currentSeconds - 1;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [snapshot.timerKey, snapshot.countdownSeconds]);

  return {
    label: snapshot.label,
    value: liveCountdownSeconds != null ? formatDuration(liveCountdownSeconds) : snapshot.value,
    countdownSeconds: liveCountdownSeconds,
    timerKey: snapshot.timerKey,
  };
}
