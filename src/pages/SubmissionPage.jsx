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

function SubmissionPage({ session, onResetExperiment, trainingUnlocked = false, isTrainingActive = false }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [result, setResult] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('Preparing validation challenge...');
  const [logLines, setLogLines] = useState(() => [createLogLine('Submit page waiting for a trained local model.')]);

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
            setStatusMessage('Validation images are ready. Run local inference when you are ready.');
            setLogLines([
              createLogLine(`Challenge ${response.submission_id.slice(0, 8)} prepared with ${response.sample_count} MNIST samples.`),
              createLogLine('Only prediction labels will be sent back to the backend.'),
            ]);
          } else {
            setStatusMessage(response.submission_block_reason || 'Submission is temporarily unavailable.');
            setLogLines([
              createLogLine('Submit page data loaded successfully.'),
              createLogLine(response.submission_block_reason || 'Submission is temporarily unavailable.'),
            ]);
          }
        });
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof ApiError ? error.message : 'Submission resources failed to load.');
        setStatusMessage('Validation challenge could not be prepared.');
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

  const modelSummary = [
    ['LATEST_VAL_ACC', toDisplayPercent(result?.accuracy ?? lastRun?.final_val_accuracy ?? lastRun?.final_accuracy), 'primary'],
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
    setStatusMessage('Loading locally trained model from IndexedDB...');
    setLogLines((current) => [...current.slice(-5), createLogLine('Locked inference backend to CPU.')]);

    try {
      await ensureCpuBackend();

      try {
        model = await tf.loadLayersModel(getStoredModelKey(bootstrap.user_id));
      } catch {
        throw new Error('No trained model was found in this browser. Please finish training once before submitting.');
      }

      setStatusMessage('Running local inference on the sampled MNIST validation set...');
      setLogLines((current) => [...current.slice(-5), createLogLine('Model weights loaded from local browser storage.')]);

      const flatPixels = decodeChallengeImages(bootstrap.challenge_images);
      xs = tf.tensor4d(flatPixels, [bootstrap.sample_count, 28, 28, 1]);
      logits = model.predict(xs);
      predictionsTensor = logits.argMax(-1);
      const predictions = Array.from(await predictionsTensor.data());

      setStatusMessage('Submitting prediction labels to backend for scoring...');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(`Inference complete. Uploading ${predictions.length} predicted labels only.`),
      ]);

      const evaluation = await evaluateSubmission({
        submission_id: bootstrap.submission_id,
        predictions,
        param_count: model.countParams(),
      }, session?.session_token);

      setResult(evaluation);
      setStatusMessage('Backend scoring complete. Accuracy has been returned to the submit page.');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(`Scored ${evaluation.correct_count}/${evaluation.sample_count} correctly.`),
        createLogLine(`Current team rank is #${evaluation.rank}.`),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : error.message || 'Submission failed.');
      setStatusMessage('Submission failed. Review the log and try again.');
      setLogLines((current) => [
        ...current.slice(-5),
        createLogLine(error instanceof ApiError ? error.message : error.message || 'Submission error.'),
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
              <h2>Model Summary</h2>

              <div className="summary-list">
                {modelSummary.map(([label, value, accent]) => (
                  <div key={label} className={`summary-item summary-item-${accent}`}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>

              <div className="summary-footer">
                <span>LAST_SUBMIT</span>
                <strong>{formatTime(latestResult?.created_at || lastRun?.updated_at)}</strong>
              </div>
            </div>

            <div className="submission-card log-card">
              <div className="log-title">
                <span className="material-symbols-outlined">info</span>
                <h3>System Log</h3>
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
                Validation <span>Submit</span>
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
                <strong>{isSubmitting ? 'SCORING...' : 'SUBMIT RESULTS'}</strong>
              </button>
            </div>

            <div className="success-card">
              <div className="success-copy">
                <div className="success-icon-box">
                  <span className="material-symbols-outlined">{result ? 'verified' : 'inventory_2'}</span>
                </div>
                <div>
                  <p>{result ? 'Scored!' : 'Ready'}</p>
                  <span>
                    {result
                      ? `Backend returned ${toDisplayPercent(result.accuracy)} on ${result.sample_count} hidden-label samples`
                      : `${bootstrap?.sample_count || 0} random MNIST validation images are loaded for local inference`}
                  </span>
                </div>
              </div>
              <div className="success-rank">
                <strong>{`#${result?.rank || (currentTeamEntry ? leaderboard.indexOf(currentTeamEntry) + 1 : '--')}`}</strong>
                <span>TEAM RANK</span>
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
                Annotation goal is not unlocked yet, so submissions stay disabled.
              </div>
            ) : null}
          </section>

          <section className="submission-column submission-column-right">
            <div className="submission-card leaderboard-card">
              <div className="leaderboard-card-head">
                <h2>Leaderboard</h2>
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
                  <div className="leaderboard-empty">No scored teams yet</div>
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
                <h4>Validation Rules</h4>
                <p>Frontend only performs inference. Backend keeps the hidden labels and computes final accuracy after submission.</p>
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
