function normalizeSeconds(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return null;
  }

  return Math.floor(value);
}

export function formatDuration(totalSeconds) {
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

export function getCompetitionTimerSnapshot(competition) {
  if (!competition) {
    return {
      label: '状态',
      value: '--',
      countdownSeconds: null,
      timerKey: 'no-competition',
    };
  }

  const timerKey = [
    competition.effective_status || 'unknown',
    competition.seconds_until_start ?? '',
    competition.seconds_until_end ?? '',
    competition.end_time ?? '',
  ].join('|');

  if (competition.effective_status === 'not_started') {
    const countdownSeconds = normalizeSeconds(competition.seconds_until_start);

    return {
      label: '开赛倒计时',
      value: countdownSeconds != null ? formatDuration(countdownSeconds) : '未开始',
      countdownSeconds,
      timerKey,
    };
  }

  if (competition.effective_status === 'ended') {
    return {
      label: '状态',
      value: '已结束',
      countdownSeconds: null,
      timerKey,
    };
  }

  if (!competition.end_time) {
    return {
      label: '状态',
      value: '进行中',
      countdownSeconds: null,
      timerKey,
    };
  }

  const countdownSeconds = normalizeSeconds(competition.seconds_until_end);

  return {
    label: '剩余时间',
    value: countdownSeconds != null ? formatDuration(countdownSeconds) : '进行中',
    countdownSeconds,
    timerKey,
  };
}
