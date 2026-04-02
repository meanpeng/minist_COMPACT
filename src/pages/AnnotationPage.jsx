import { useEffect, useMemo, useRef, useState } from 'react';
import AppChrome from '../components/AppChrome';
import { ApiError, submitAnnotation } from '../lib/api';

const labelDigits = Array.from({ length: 10 }, (_, index) => index);
const BRUSH_SIZE = 24;
const CANVAS_EXPORT_SIZE = 28;
const MNIST_DIGIT_BOX_SIZE = 20;
function createEmptyStats(teamId = '') {
  return {
    team_id: teamId,
    total_count: 0,
    goal: 50,
    remaining_to_goal: 50,
    progress_ratio: 0,
    counts_by_label: Array.from({ length: 10 }, () => 0),
  };
}

function AnnotationPage({
  session,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
  stats,
  isStatsLoading = false,
  onAnnotationStatsChange,
}) {
  const canvasRef = useRef(null);
  const surfaceRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const historyRef = useRef([]);
  const [selectedDigit, setSelectedDigit] = useState(0);
  const [hasInk, setHasInk] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Draw a digit, then choose its label to upload.');
  const [isSubmittingLabel, setIsSubmittingLabel] = useState(null);

  const teamId = session?.team?.id || '';
  const sessionToken = session?.session_token || '';
  const displayStats = stats ?? createEmptyStats(teamId);

  const activeSegments = Math.max(0, Math.min(10, Math.round(displayStats.progress_ratio * 10)));
  const trainSamplesRemaining = Math.max(displayStats.remaining_to_goal, 0);
  const distributionBars = useMemo(() => {
    const maxCount = Math.max(...displayStats.counts_by_label, 0);
    if (maxCount === 0) {
      return displayStats.counts_by_label.map(() => 0);
    }

    return displayStats.counts_by_label.map((count) => (count / maxCount) * 100);
  }, [displayStats.counts_by_label]);

  const getCanvasLogicalSize = () => {
    const canvas = canvasRef.current;
    return {
      width: canvas?.clientWidth || 0,
      height: canvas?.clientHeight || 0,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) {
      return undefined;
    }

    const renderSnapshot = (snapshotUrl) => {
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }

      const { width, height } = getCanvasLogicalSize();

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

      if (!snapshotUrl) {
        return;
      }

      const image = new Image();
      image.onload = () => {
        context.drawImage(image, 0, 0, width, height);
      };
      image.src = snapshotUrl;
    };

    const resizeCanvas = () => {
      const rect = surface.getBoundingClientRect();
      const nextSize = Math.max(Math.floor(rect.width), 1);
      const devicePixelRatio = window.devicePixelRatio || 1;
      const snapshot = historyRef.current.at(-1) || null;

      canvas.width = Math.round(nextSize * devicePixelRatio);
      canvas.height = Math.round(nextSize * devicePixelRatio);
      canvas.style.width = `${nextSize}px`;
      canvas.style.height = `${nextSize}px`;

      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }

      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = '#ffffff';
      context.fillStyle = '#ffffff';
      context.shadowColor = 'rgba(255, 255, 255, 0.95)';
      context.shadowBlur = 2;
      context.lineWidth = BRUSH_SIZE;
      context.imageSmoothingEnabled = true;

      renderSnapshot(snapshot);
    };

    resizeCanvas();
    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(surface);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key >= '0' && event.key <= '9') {
        event.preventDefault();
        handleLabelSelection(Number(event.key));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    const { width, height } = getCanvasLogicalSize();
    context.clearRect(0, 0, width, height);
    historyRef.current = [];
    lastPointRef.current = null;
    isDrawingRef.current = false;
    setHasInk(false);
    setStatusMessage('Canvas cleared. Draw a digit, then choose its label to upload.');
  };

  const undoLastStroke = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || historyRef.current.length === 0) {
      return;
    }

    historyRef.current.pop();
    const { width, height } = getCanvasLogicalSize();
    context.clearRect(0, 0, width, height);

    const previousSnapshot = historyRef.current.at(-1);
    if (!previousSnapshot) {
      setHasInk(false);
      setStatusMessage('Undo complete. Canvas is empty now.');
      return;
    }

    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, width, height);
    };
    image.src = previousSnapshot;
    setHasInk(true);
    setStatusMessage('Last stroke removed.');
  };

  const getRelativePoint = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const startDrawing = (event) => {
    const context = canvasRef.current?.getContext('2d');
    const point = getRelativePoint(event);
    if (!context || !point) {
      return;
    }

    isDrawingRef.current = true;
    lastPointRef.current = point;
    context.beginPath();
    context.arc(point.x, point.y, BRUSH_SIZE / 2, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    setHasInk(true);
  };

  const draw = (event) => {
    if (!isDrawingRef.current) {
      return;
    }

    const context = canvasRef.current?.getContext('2d');
    const nextPoint = getRelativePoint(event);
    const previousPoint = lastPointRef.current;
    if (!context || !nextPoint || !previousPoint) {
      return;
    }

    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y);
    context.lineTo(nextPoint.x, nextPoint.y);
    context.stroke();
    lastPointRef.current = nextPoint;
  };

  const stopDrawing = () => {
    if (!isDrawingRef.current || !canvasRef.current) {
      return;
    }

    isDrawingRef.current = false;
    lastPointRef.current = null;
    historyRef.current.push(canvasRef.current.toDataURL('image/png'));
  };

  const exportCanvasAsBase64 = () => {
    const sourceCanvas = canvasRef.current;
    if (!sourceCanvas) {
      return '';
    }

    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const samplingCanvas = document.createElement('canvas');
    samplingCanvas.width = sourceWidth;
    samplingCanvas.height = sourceHeight;

    const samplingContext = samplingCanvas.getContext('2d', { willReadFrequently: true });
    if (!samplingContext) {
      return '';
    }

    samplingContext.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight);
    const imageData = samplingContext.getImageData(0, 0, sourceWidth, sourceHeight);
    const { data } = imageData;

    let minX = sourceWidth;
    let minY = sourceHeight;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const index = (y * sourceWidth + x) * 4;
        const alpha = data[index + 3];
        const brightness = data[index];
        if (alpha > 0 && brightness > 16) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = CANVAS_EXPORT_SIZE;
    exportCanvas.height = CANVAS_EXPORT_SIZE;

    const exportContext = exportCanvas.getContext('2d');
    if (!exportContext) {
      return '';
    }

    if (maxX < minX || maxY < minY) {
      exportContext.fillStyle = '#000000';
      exportContext.fillRect(0, 0, CANVAS_EXPORT_SIZE, CANVAS_EXPORT_SIZE);
      return exportCanvas.toDataURL('image/png');
    }

    const boundingWidth = maxX - minX + 1;
    const boundingHeight = maxY - minY + 1;
    const largestSide = Math.max(boundingWidth, boundingHeight);

    const normalizedCanvas = document.createElement('canvas');
    normalizedCanvas.width = CANVAS_EXPORT_SIZE;
    normalizedCanvas.height = CANVAS_EXPORT_SIZE;
    const normalizedContext = normalizedCanvas.getContext('2d', { willReadFrequently: true });
    if (!normalizedContext) {
      return '';
    }

    normalizedContext.fillStyle = '#000000';
    normalizedContext.fillRect(0, 0, CANVAS_EXPORT_SIZE, CANVAS_EXPORT_SIZE);

    const scale = MNIST_DIGIT_BOX_SIZE / largestSide;
    const scaledWidth = Math.max(1, Math.round(boundingWidth * scale));
    const scaledHeight = Math.max(1, Math.round(boundingHeight * scale));
    const initialOffsetX = (CANVAS_EXPORT_SIZE - scaledWidth) / 2;
    const initialOffsetY = (CANVAS_EXPORT_SIZE - scaledHeight) / 2;

    normalizedContext.imageSmoothingEnabled = true;
    normalizedContext.drawImage(
      samplingCanvas,
      minX,
      minY,
      boundingWidth,
      boundingHeight,
      initialOffsetX,
      initialOffsetY,
      scaledWidth,
      scaledHeight,
    );

    const normalizedImageData = normalizedContext.getImageData(
      0,
      0,
      CANVAS_EXPORT_SIZE,
      CANVAS_EXPORT_SIZE,
    );
    const normalizedPixels = normalizedImageData.data;

    let sumIntensity = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let y = 0; y < CANVAS_EXPORT_SIZE; y += 1) {
      for (let x = 0; x < CANVAS_EXPORT_SIZE; x += 1) {
        const index = (y * CANVAS_EXPORT_SIZE + x) * 4;
        const intensity = normalizedPixels[index];
        if (intensity === 0) {
          continue;
        }

        sumIntensity += intensity;
        weightedX += x * intensity;
        weightedY += y * intensity;
      }
    }

    const centerX = sumIntensity > 0 ? weightedX / sumIntensity : (CANVAS_EXPORT_SIZE - 1) / 2;
    const centerY = sumIntensity > 0 ? weightedY / sumIntensity : (CANVAS_EXPORT_SIZE - 1) / 2;
    const targetCenter = (CANVAS_EXPORT_SIZE - 1) / 2;
    const shiftX = targetCenter - centerX;
    const shiftY = targetCenter - centerY;

    exportContext.fillStyle = '#000000';
    exportContext.fillRect(0, 0, CANVAS_EXPORT_SIZE, CANVAS_EXPORT_SIZE);
    exportContext.imageSmoothingEnabled = false;
    exportContext.drawImage(normalizedCanvas, shiftX, shiftY);

    return exportCanvas.toDataURL('image/png');
  };

  async function handleLabelSelection(digit) {
    setSelectedDigit(digit);

    if (!sessionToken || !teamId) {
      setStatusMessage('Please join or create a team before annotating.');
      return;
    }

    if (!hasInk) {
      setStatusMessage(`Label ${digit} selected. Draw a digit first, then upload it.`);
      return;
    }

    setIsSubmittingLabel(digit);
    setStatusMessage(`Uploading digit ${digit} to your team dataset...`);

    try {
      const response = await submitAnnotation({
        label: digit,
        image_base64: exportCanvasAsBase64(),
      }, sessionToken);

      onAnnotationStatsChange?.(response.stats);
      clearCanvas();
      setStatusMessage(
        `Digit ${digit} uploaded. Team ${session?.team?.name || ''} now has ${response.stats.total_count} labeled samples.`,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof ApiError ? error.message : 'Upload failed. Please try again.',
      );
    } finally {
      setIsSubmittingLabel(null);
    }
  }

  return (
    <AppChrome
      activeSection="annotation"
      session={session}
      onResetExperiment={onResetExperiment}
      trainingUnlocked={trainingUnlocked}
      isTrainingActive={isTrainingActive}
    >
      <main className="annotation-main">
        <div className="annotation-bg annotation-bg-primary" aria-hidden="true" />
        <div className="annotation-bg annotation-bg-secondary" aria-hidden="true" />

        <div className="annotation-grid">
          <section className="canvas-panel">
            <div className="canvas-header">
              <div>
                <h1>Draw Digit</h1>
                <p>INPUT_STREAM: RAW_HANDWRITING_V1</p>
              </div>
              <div className="canvas-tools">
                <button
                  type="button"
                  className="tool-button tool-button-delete"
                  onClick={clearCanvas}
                  aria-label="Clear canvas"
                >
                  <span className="material-symbols-outlined">delete</span>
                </button>
                <button
                  type="button"
                  className="tool-button tool-button-undo"
                  onClick={undoLastStroke}
                  aria-label="Undo last stroke"
                >
                  <span className="material-symbols-outlined">undo</span>
                </button>
              </div>
            </div>

            <div className="draw-surface" ref={surfaceRef}>
              <canvas
                ref={canvasRef}
                className="draw-canvas"
                onPointerDown={startDrawing}
                onPointerMove={draw}
                onPointerUp={stopDrawing}
                onPointerLeave={stopDrawing}
                onPointerCancel={stopDrawing}
              />
              {!hasInk ? (
                <div className="draw-surface-placeholder" aria-hidden="true">
                  <span className="material-symbols-outlined">draw</span>
                </div>
              ) : null}
              <div className="draw-corner draw-corner-top-left" />
              <div className="draw-corner draw-corner-top-right" />
              <div className="draw-corner draw-corner-bottom-left" />
              <div className="draw-corner draw-corner-bottom-right" />
            </div>

            <div className="canvas-footer">
              <span>{statusMessage}</span>
              <span>RESOLUTION: 28x28_MNIST_STYLIZED</span>
            </div>
          </section>

          <section className="annotation-side-panels">
            <div className="label-panel">
              <h2>
                <span className="material-symbols-outlined">sell</span>
                SELECT_LABEL
              </h2>
              <div className="digit-grid">
                {labelDigits.map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    className={digit === selectedDigit ? 'digit-button digit-button-active' : 'digit-button'}
                    disabled={isSubmittingLabel !== null}
                    onClick={() => handleLabelSelection(digit)}
                  >
                    {isSubmittingLabel === digit ? '...' : digit}
                  </button>
                ))}
              </div>
              <p>KEYBOARD_SHORTCUTS: [0-9]</p>
            </div>

            <div className="progress-panel">
              <div className="progress-head">
                <h2>SESSION_PROGRESS</h2>
                <span>{isStatsLoading ? '--' : `${Math.round(displayStats.progress_ratio * 100)}%`}</span>
              </div>
              <div className="progress-bar-segments" aria-hidden="true">
                {Array.from({ length: 10 }, (_, index) => (
                  <div
                    key={index}
                    className={
                      index < activeSegments
                        ? 'progress-bar-segment progress-bar-segment-active'
                        : 'progress-bar-segment'
                    }
                  />
                ))}
              </div>
              <div className="progress-meta">
                <span>{`TOTAL_LABELED: ${displayStats.total_count.toLocaleString()}`}</span>
                <span>{`GOAL: ${displayStats.goal.toLocaleString()}`}</span>
              </div>
            </div>

            <div className="distribution-panel">
              <h2>LABEL_DISTRIBUTION_CHART</h2>
              <div className="distribution-panel-chart">
                {distributionBars.map((height, index) => (
                  <div key={index} className="distribution-panel-column">
                    <div className="distribution-panel-count">{displayStats.counts_by_label[index]}</div>
                    <div className="distribution-panel-bar" style={{ height: `${height}%` }} />
                    <span>{index}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="train-panel">
            <div className="train-frame">
              <button
                type="button"
                className={trainingUnlocked ? 'train-button train-button-unlocked' : 'train-button'}
                disabled={!trainingUnlocked}
                onClick={() => {
                  if (trainingUnlocked) {
                    window.location.hash = 'training';
                  }
                }}
              >
                <div className="train-button-overlay" aria-hidden="true" />
                <span className="material-symbols-outlined train-lock">
                  {trainingUnlocked ? 'lock_open' : 'lock'}
                </span>
                <div className="train-copy">
                  <span className="train-title">TRAIN MODEL</span>
                  <span className="train-subtitle">
                    {trainingUnlocked
                      ? 'TEAM DATASET READY FOR TRAINING'
                      : `NEED ${trainSamplesRemaining.toLocaleString()} MORE SAMPLES TO UNLOCK CORE TRAINING`}
                  </span>
                </div>
                <div className="train-progress">
                  <div className="train-progress-bar">
                    <div
                      className="train-progress-fill"
                      style={{ width: `${Math.round(displayStats.progress_ratio * 100)}%` }}
                    />
                  </div>
                  <div className="train-progress-text">
                    {`${displayStats.total_count.toLocaleString()} / ${displayStats.goal.toLocaleString()}`}
                  </div>
                </div>
              </button>
              <div className="train-corner train-corner-top-left" aria-hidden="true" />
              <div className="train-corner train-corner-bottom-right" aria-hidden="true" />
            </div>
          </section>
        </div>
      </main>
    </AppChrome>
  );
}

export default AnnotationPage;
