import { startTransition, useEffect, useMemo, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import AppChrome from '../components/AppChrome';
import { ApiError, evaluateSubmission, fetchSubmissionBootstrap } from '../lib/api';
import { ensureCpuBackend, getStoredModelKey } from '../lib/tfModel';

function toDisplayPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  return `${(value * 100).toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) {
    return '--';
  }

  return new Date(value).toLocaleString();
}

function createLogLine(message) {
  return `[${new Date().toLocaleTimeString()}] ${message}`;
}

function decodeChallengeImages(challengeImages) {
  const sampleCount = challengeImages.length;
  const flatPixels = new Float32Array(sampleCount * 28 * 28);

  challengeImages.forEach((image, sampleIndex) => {
    const bytes = Uint8Array.from(atob(image.pixels_b64), (char) => char.charCodeAt(0));
    bytes.forEach((value, pixelIndex) => {
      flatPixels[sampleIndex * 28 * 28 + pixelIndex] = value / 255;
    });
  });

  return flatPixels;
}

function findCurrentTeamEntry(leaderboard, teamId) {
  return leaderboard.find((entry) => entry.team_id === teamId) || null;
}

function formatRemainingAttempts(remaining, limit) {
  if (typeof remaining !== 'number' || typeof limit !== 'number') {
    return '--';
  }

  return `${remaining}/${limit}`;
}

function SubmissionPage({
  session,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
  competitionTimer,
}) {
  const [bootstrap, setBootstrap] = useState(null);
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('正在准备最终挑战...');
  const [logLines, setLogLines] = useState(() => [createLogLine('提交面板正在等待本地训练好的模型。')]);

  useEffect(() => {
    let isActive = true;

    async function loadBootstrap() {
      if (!session?.session_token) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setErrorMessage('');

      try {
        const response = await fetchSubmissionBootstrap(session.session_token);
        if (!isActive) {
          return;
        }

        startTransition(() => {
          setBootstrap(response);
          setResult(null);
          if (response.submission_available) {
            setStatusMessage('挑战样本已就绪，随时可以开始本地推理。');
            setLogLines([
              createLogLine(`Challenge ${response.submission_id.slice(0, 8)} 已生成，共 ${response.sample_count} 张 MNIST 样本。`),
              createLogLine('提交时只会上传预测标签，模型仍保留在本地。'),
            ]);
          } else {
            setStatusMessage(response.submission_block_reason || '当前暂时无法提交。');
            setLogLines([
              createLogLine('提交面板数据已载入。'),
              createLogLine(response.submission_block_reason || '当前暂时无法提交。'),
            ]);
          }
        });
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof ApiError ? error.message : '提交资源加载失败。');
        setStatusMessage('挑战任务准备失败。');
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    loadBootstrap();

    return () => {
      isActive = false;
    };
  }, [session?.session_token]);

  const leaderboard = result?.leaderboard || bootstrap?.leaderboard || [];
  const latestResult = result?.latest_result || bootstrap?.latest_result || null;
  const lastRun = bootstrap?.latest_run || null;
  const remainingTeamAttempts = result?.remaining_team_attempts ?? bootstrap?.remaining_team_attempts;
  const teamSubmissionLimit = result?.team_submission_limit ?? bootstrap?.team_submission_limit;
  const submissionAvailable = Boolean(bootstrap?.submission_available);
  const submissionBlockReason = bootstrap?.submission_block_reason || '';
  const currentTeamEntry = useMemo(
    () => findCurrentTeamEntry(leaderboard, session?.team?.id),
    [leaderboard, session?.team?.id],
  );
  const currentTestAccuracy = result?.accuracy ?? null;

  const modelSummary = [
    ['LATEST_VAL_ACC', toDisplayPercent(lastRun?.final_val_accuracy ?? lastRun?.final_accuracy), 'primary'],
    ['CORRECT / TOTAL', result ? `${result.correct_count}/${result.sample_count}` : `${bootstrap?.sample_count || '--'} SAMPLES`, 'error'],
    [
      'TOTAL_PARAMS',
      latestResult?.param_count?.toLocaleString?.() || bootstrap?.modeling_config?.summary?.param_count?.toLocaleString?.() || '--',
      'tertiary',
    ],
    ['TEAM_ATTEMPTS_LEFT', formatRemainingAttempts(remainingTeamAttempts, teamSubmissionLimit), 'secondary'],
  ];

  async function handleSubmit() {
    if (!bootstrap || isSubmitting || !bootstrap.submission_available || !bootstrap.submission_id) {
      return;
    }

    let xs = null;
    let logits = null;
    let predictionsTensor = null;
    let model = null;

    setIsSubmitting(true);
    setErrorMessage('');
    setStatusMessage('正在从 IndexedDB 读取本地模型...');
    setLogLines((current) => [...current.slice(-5), createLogLine('Inference backend 已锁定为 CPU。')]);

    try {
      await ensureCpuBackend();

      try {
        model = await tf.loadLayersModel(getStoredModelKey(bootstrap.user_id));
      } catch {
        throw new Error('当前浏览器里没有训练好的模型，请先完成至少一次训练。');
      }

      setStatusMessage('正在对抽取的 MNIST 样本执行本地推理...');
      setLogLines((current) => [...current.slice(-5), createLogLine('模型权重已从本地浏览器存储载入。')]);

      const flatPixels = decodeChallengeImages(bootstrap.challenge_images);
      xs = tf.tensor4d(flatPixels, [bootstrap.sample_count, 28, 28, 1]);
      logits = model.predict(xs);
      predictionsTensor = logits.argMax(-1);
      const predictions = Array.from(await predictionsTensor.data());

      setStatusMessage('正在把预测结果送去评分...');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(`推理完成，正在上传 ${predictions.length} 个预测标签。`),
      ]);

      const evaluation = await evaluateSubmission({
        submission_id: bootstrap.submission_id,
        predictions,
        param_count: model.countParams(),
      }, session?.session_token);

      setResult(evaluation);
      setStatusMessage('评分完成，结果已返回。');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(`命中 ${evaluation.correct_count}/${evaluation.sample_count}。`),
        createLogLine(`当前队伍排名 #${evaluation.rank}。`),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : error.message || '提交失败。');
      setStatusMessage('提交失败，请检查记录后重试。');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(error instanceof ApiError ? error.message : error.message || '提交出错。'),
      ]);
    } finally {
      xs?.dispose();
      logits?.dispose?.();
      predictionsTensor?.dispose();
      model?.dispose?.();
      setIsSubmitting(false);
    }
  }

  return (
    <AppChrome
      activeSection="submission"
      session={session}
      competitionTimer={competitionTimer}
      onResetExperiment={onResetExperiment}
      trainingUnlocked={trainingUnlocked}
      isTrainingActive={isTrainingActive}
    >
      <main className="submission-main">
        <div className="submission-grid">
          <section className="submission-column submission-column-left">
            <div className="submission-card summary-card">
              <div className="summary-icon" aria-hidden="true">
                <span className="material-symbols-outlined">inventory_2</span>
              </div>
              <h2>提交前检查</h2>

              <div className="summary-list">
                {modelSummary.map(([label, value, accent]) => (
                  <div key={label} className={`summary-item summary-item-${accent}`}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>

              <div className="summary-footer">
                <span>最近提交</span>
                <strong>{formatTime(latestResult?.created_at || lastRun?.updated_at)}</strong>
              </div>
            </div>

            <div className="submission-card log-card">
              <div className="log-title">
                <span className="material-symbols-outlined">info</span>
                <h3>运行记录</h3>
              </div>
              <div className="log-list">
                {logLines.map((entry) => (
                  <p key={entry} className={entry.includes('complete') ? 'log-line log-line-active' : 'log-line'}>
                    {entry}
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="submission-column submission-column-center">
            <div className="mission-copy">
              <h1>
                FINAL <span>SUBMIT</span>
              </h1>
              <p>{statusMessage}</p>
            </div>

            <div className="submit-cta-shell">
              <div className="submit-glow" aria-hidden="true" />
              <button
                type="button"
                className="submit-cta"
                onClick={handleSubmit}
                disabled={isLoading || isSubmitting || !trainingUnlocked || !submissionAvailable}
              >
                <div className="submit-ring" aria-hidden="true" />
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
                >
                  {isSubmitting ? 'hourglass_top' : 'send'}
                </span>
                <strong>{isSubmitting ? '评分中...' : '提交结果'}</strong>
              </button>
            </div>

            <div className="success-card">
              <div className="success-copy">
                <div className="success-icon-box">
                  <span className="material-symbols-outlined">{result ? 'verified' : 'inventory_2'}</span>
                </div>
                <div>
                  <p>{result ? '本次挑战已评分' : 'READY'}</p>
                  <span>
                    {result
                      ? `本次成绩 ${toDisplayPercent(result.accuracy)}，共 ${result.sample_count} 个隐藏标签样本。`
                      : `已加载 ${bootstrap?.sample_count || 0} 张随机 MNIST 样本，等待本地推理。`}
                  </span>
                </div>
              </div>
              <div className="success-rank">
                <strong>{result ? `#${result.rank}` : `#${currentTeamEntry ? leaderboard.indexOf(currentTeamEntry) + 1 : '--'}`}</strong>
                <span>队伍排名</span>
              </div>
            </div>

            {errorMessage ? <div className="submission-banner submission-banner-error">{errorMessage}</div> : null}
            {!errorMessage && trainingUnlocked && !submissionAvailable && submissionBlockReason ? (
              <div className="submission-banner submission-banner-warning">
                {submissionBlockReason}
              </div>
            ) : null}
            {!errorMessage && !trainingUnlocked ? (
              <div className="submission-banner submission-banner-warning">
                标注目标尚未达成，FINAL SUBMIT 暂未开放。
              </div>
            ) : null}
          </section>

          <section className="submission-column submission-column-right">
            <div className={`submission-result-panel ${result ? 'submission-result-panel-ready' : ''}`} aria-live="polite">
              <div className="submission-result-label">本次挑战精度</div>
              <div className="submission-result-score">{toDisplayPercent(currentTestAccuracy)}</div>
            </div>

            <div className="submission-card leaderboard-card">
              <div className="leaderboard-card-head">
                <h2>赛事榜</h2>
                <span>{`TOP_${leaderboard.length || 0}`}</span>
              </div>

              <div className="submission-leaderboard">
                {leaderboard.length ? (
                  leaderboard.map((entry, index) => {
                    const isActive = entry.team_id === session?.team?.id;
                    return (
                      <div
                        key={`${entry.team_id}-${entry.created_at}`}
                        className={isActive ? 'leaderboard-entry leaderboard-entry-active' : 'leaderboard-entry'}
                      >
                        <div>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <span>{entry.team_name}</span>
                        </div>
                        <strong>{toDisplayPercent(entry.accuracy)}</strong>
                      </div>
                    );
                  })
                ) : (
                  <div className="leaderboard-empty">还没有队伍上榜</div>
                )}
              </div>

              <div className="connection-preview">
                <div className="submission-meta-grid">
                  <p>{`CHALLENGE_ID: ${bootstrap?.submission_id?.slice(0, 8) || '--'}`}</p>
                  <p>{`SUBMITTED_BY: ${latestResult?.submitted_by || session?.user?.username || '--'}`}</p>
                  <p>{`LATEST_SCORE: ${toDisplayPercent(latestResult?.accuracy)}`}</p>
                  <p>{`TEAM_ATTEMPTS_LEFT: ${formatRemainingAttempts(remainingTeamAttempts, teamSubmissionLimit)}`}</p>
                </div>
              </div>
            </div>

            <div className="submission-card achievement-card">
              <div className="achievement-copy">
                <span className="material-symbols-outlined">military_tech</span>
                <h4>提交说明</h4>
                <p>前端只负责本地推理，隐藏标签保存在后端，最终成绩由后端统一评分。</p>
              </div>
              <div className="achievement-mark" aria-hidden="true">
                <span
                  className="material-symbols-outlined"
                  style={{ fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
                >
                  shield
                </span>
              </div>
            </div>
          </section>
        </div>
      </main>
    </AppChrome>
  );
}

export default SubmissionPage;
