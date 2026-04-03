import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import AppChrome from '../components/AppChrome';
import {
  ApiError,
  buildApiUrl,
  fetchTrainingBootstrap,
  saveTrainingRun,
} from '../lib/api';
import {
  buildTfModel,
  ensureCpuBackend,
  getStoredModelKey,
  IMAGE_SIZE,
} from '../lib/tfModel';

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_EPOCHS = 8;
const DEFAULT_LEARNING_RATE = 0.001;
const DEFAULT_AUGMENT_COPIES = 1;
const BATCH_SIZE_OPTIONS = [8, 16, 32, 64];
const EPOCH_OPTIONS = [5, 8, 10, 15, 20];
const LEARNING_RATE_OPTIONS = [0.0005, 0.001, 0.002, 0.005];
const AUGMENT_COPIES_OPTIONS = [1, 2, 3, 4];
const AUGMENTATION_OPTIONS = [
  { value: 'shift', label: '平移' },
  { value: 'scale', label: '缩放' },
  { value: 'rotation', label: '旋转' },
  { value: 'affine', label: '仿射变换' },
];
const AUGMENTATION_LABELS = {
  shift: '平移',
  scale: '缩放',
  rotation: '旋转',
  affine: '仿射',
};
const LOG_LIMIT = 8;

const EMPTY_PROGRESS = {
  currentEpoch: 0,
  totalEpochs: 0,
  percent: 0,
  status: 'IDLE',
};

function createEmptyMetrics() {
  return {
    loss: [],
    accuracy: [],
    valLoss: [],
    valAccuracy: [],
  };
}

function toDisplayPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  return `${(value * 100).toFixed(1)}%`;
}

function toDisplayMetric(value, digits = 4) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }

  return value.toFixed(digits);
}

function toChartPoints(values) {
  if (!values.length) {
    return '';
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = 90 - ((value - min) / range) * 80;
      return `${x},${y}`;
    })
    .join(' ');
}

function createLogLine(message) {
  return [`[${new Date().toLocaleTimeString()}]`, message];
}

function formatAugmentationModes(modes) {
  if (!modes?.length) {
    return '未开启';
  }

  return modes.map((mode) => AUGMENTATION_LABELS[mode] || mode).join(', ');
}

function getMetricValue(logs, primaryKey, fallbackKey) {
  if (typeof logs?.[primaryKey] === 'number') {
    return logs[primaryKey];
  }

  if (typeof logs?.[fallbackKey] === 'number') {
    return logs[fallbackKey];
  }

  return null;
}

async function loadImagePixels(imageUrl) {
  const response = await fetch(buildApiUrl(imageUrl));
  if (!response.ok) {
    throw new Error('图片下载失败。');
  }

  const blob = await response.blob();
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    throw new Error('无法创建图像上下文。');
  }

  context.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    context.drawImage(bitmap, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
    bitmap.close();
  } else {
    const objectUrl = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          context.drawImage(image, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
          resolve();
        };
        image.onerror = () => reject(new Error('Image decode failed.'));
        image.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const { data } = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);

  const pixels = new Float32Array(IMAGE_SIZE * IMAGE_SIZE);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = data[index * 4] / 255;
  }

  return pixels;
}

async function createDatasetTensors(samples) {
  const settled = await Promise.allSettled(samples.map((sample) => loadImagePixels(sample.image_url)));
  const usableSamples = [];
  const pixelArrays = [];

  settled.forEach((result, index) => {
    if (result.status !== 'fulfilled') {
      return;
    }

    usableSamples.push(samples[index]);
    pixelArrays.push(result.value);
  });

  if (!usableSamples.length) {
    throw new Error('没有可用于训练的样本。');
  }

  const featureBuffer = new Float32Array(samples.length * IMAGE_SIZE * IMAGE_SIZE);

  pixelArrays.forEach((pixels, index) => {
    featureBuffer.set(pixels, index * IMAGE_SIZE * IMAGE_SIZE);
  });

  const xs = tf.tensor4d(featureBuffer.subarray(0, usableSamples.length * IMAGE_SIZE * IMAGE_SIZE), [
    usableSamples.length,
    IMAGE_SIZE,
    IMAGE_SIZE,
    1,
  ]);
  const labelTensor = tf.tensor1d(
    usableSamples.map((sample) => sample.label),
    'int32',
  );
  const ys = tf.oneHot(labelTensor, 10).toFloat();
  labelTensor.dispose();

  return {
    xs,
    ys,
    usableSampleCount: usableSamples.length,
    skippedSampleCount: samples.length - usableSamples.length,
  };
}

function createPrng(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randomFloat(rng, min, max) {
  return rng() * (max - min) + min;
}

function translateImage(image, dx, dy) {
  const padTop = Math.max(dy, 0);
  const padBottom = Math.max(-dy, 0);
  const padLeft = Math.max(dx, 0);
  const padRight = Math.max(-dx, 0);
  const startY = dy < 0 ? -dy : 0;
  const startX = dx < 0 ? -dx : 0;

  return tf.tidy(() => {
    const padded = tf.pad(image, [
      [padTop, padBottom],
      [padLeft, padRight],
      [0, 0],
    ]);
    return padded.slice([startY, startX, 0], [IMAGE_SIZE, IMAGE_SIZE, 1]);
  });
}

function scaleImage(image, scale) {
  return tf.tidy(() => {
    const scaledSize = Math.max(18, Math.round(IMAGE_SIZE * scale));
    const expanded = image.expandDims(0);
    const resized = tf.image.resizeBilinear(expanded, [scaledSize, scaledSize], false).squeeze([0]);

    if (scaledSize >= IMAGE_SIZE) {
      const offset = Math.floor((scaledSize - IMAGE_SIZE) / 2);
      return resized.slice([offset, offset, 0], [IMAGE_SIZE, IMAGE_SIZE, 1]);
    }

    const padBefore = Math.floor((IMAGE_SIZE - scaledSize) / 2);
    const padAfter = IMAGE_SIZE - scaledSize - padBefore;
    return tf.pad(resized, [
      [padBefore, padAfter],
      [padBefore, padAfter],
      [0, 0],
    ]);
  });
}

function rotateImage(image, angle) {
  return tf.tidy(() => {
    if (typeof tf.image.rotateWithOffset !== 'function') {
      return image.clone();
    }

    const batched = image.expandDims(0);
    const rotated = tf.image.rotateWithOffset(batched, angle, 0, 0, 'bilinear', 0);
    return rotated.squeeze([0]);
  });
}

function augmentOneImage(image, rng, selectedModes) {
  return tf.tidy(() => {
    let augmented = image.clone();

    if (selectedModes.includes('rotation')) {
      const angle = randomFloat(rng, -0.22, 0.22);
      augmented = rotateImage(augmented, angle);
    }

    if (selectedModes.includes('shift')) {
      const dx = randomInt(rng, -2, 2);
      const dy = randomInt(rng, -2, 2);
      augmented = translateImage(augmented, dx, dy);
    }

    if (selectedModes.includes('scale')) {
      const scale = randomFloat(rng, 0.88, 1.12);
      augmented = scaleImage(augmented, scale);
    }

    if (selectedModes.includes('affine')) {
      const angle = randomFloat(rng, -0.18, 0.18);
      augmented = rotateImage(augmented, angle);
      augmented = scaleImage(augmented, randomFloat(rng, 0.9, 1.08));
      augmented = translateImage(augmented, randomInt(rng, -3, 3), randomInt(rng, -3, 3));
    }

    return augmented.clipByValue(0, 1).clone();
  });
}

function buildAugmentedDataset(xs, ys, selectedModes, augmentCopies) {
  if (!selectedModes.length) {
    return {
      xs,
      ys,
      dispose: false,
      effectiveSampleCount: xs.shape[0],
    };
  }

  const baseImages = tf.unstack(xs);
  const rng = createPrng(123456789);
  const imageVariants = [xs];
  const labelVariants = [ys];

  for (let copyIndex = 0; copyIndex < augmentCopies; copyIndex += 1) {
    const augmentedImages = baseImages.map((image) => augmentOneImage(image, rng, selectedModes));
    const augmentedXs = tf.stack(augmentedImages);
    imageVariants.push(augmentedXs);
    labelVariants.push(ys.clone());
    augmentedImages.forEach((image) => image.dispose());
  }

  const finalXs = tf.concat(imageVariants, 0);
  const finalYs = tf.concat(labelVariants, 0);

  baseImages.forEach((image) => image.dispose());
  imageVariants.slice(1).forEach((tensor) => tensor.dispose());
  labelVariants.slice(1).forEach((tensor) => tensor.dispose());

  return {
    xs: finalXs,
    ys: finalYs,
    dispose: true,
    effectiveSampleCount: xs.shape[0] * (augmentCopies + 1),
  };
}

function buildMetricsFromRun(run) {
  if (!run?.logs?.length) {
    return createEmptyMetrics();
  }

  return {
    loss: run.logs.map((point) => point.loss),
    accuracy: run.logs.map((point) => point.accuracy),
    valLoss: run.logs.map((point) => point.val_loss).filter((value) => typeof value === 'number'),
    valAccuracy: run.logs.map((point) => point.val_accuracy).filter((value) => typeof value === 'number'),
  };
}

function buildLogFeed(run) {
  if (!run?.logs?.length) {
    return [createLogLine('等待开始训练，后端固定使用 CPU 模式。')];
  }

  return run.logs
    .slice(-LOG_LIMIT)
    .map((point) =>
      createLogLine(
        `Epoch ${point.epoch}: loss ${point.loss.toFixed(4)} | acc ${toDisplayPercent(point.accuracy)}${
          typeof point.val_accuracy === 'number' ? ` | val ${toDisplayPercent(point.val_accuracy)}` : ''
        }`,
      ),
    );
}

function TrainingPage({
  session,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
  onTrainingStateChange,
  competitionTimer,
}) {
  const [bootstrap, setBootstrap] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTraining, setIsTraining] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('正在同步训练环境...');
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [epochs, setEpochs] = useState(DEFAULT_EPOCHS);
  const [learningRate, setLearningRate] = useState(DEFAULT_LEARNING_RATE);
  const [augmentCopies, setAugmentCopies] = useState(DEFAULT_AUGMENT_COPIES);
  const [augmentationModes, setAugmentationModes] = useState([]);
  const [metrics, setMetrics] = useState(createEmptyMetrics);
  const [logFeed, setLogFeed] = useState(() => [createLogLine('等待训练启动，后端固定使用 CPU 模式。')]);
  const [progress, setProgress] = useState(EMPTY_PROGRESS);
  const trainingRef = useRef(false);

  useEffect(() => {
    let isActive = true;

    async function loadTrainingBootstrap() {
      if (!session?.session_token) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setErrorMessage('');

      try {
        const response = await fetchTrainingBootstrap(session.session_token);
        if (!isActive) {
          return;
        }

        startTransition(() => {
          setBootstrap(response);
          setMetrics(buildMetricsFromRun(response.latest_run));
          setLogFeed(buildLogFeed(response.latest_run));
          setStatusMessage(
            response.latest_run
              ? '最近一次训练记录已同步，可以继续冲刺。'
              : '训练环境已就绪，准备开启挑战。',
          );
          setBatchSize(response.latest_run?.batch_size || DEFAULT_BATCH_SIZE);
          setEpochs(response.latest_run?.epochs || DEFAULT_EPOCHS);
          setLearningRate(response.latest_run?.learning_rate || DEFAULT_LEARNING_RATE);
          setAugmentCopies(response.latest_run?.augment_copies || DEFAULT_AUGMENT_COPIES);
          setAugmentationModes(response.latest_run?.augmentation_modes || []);
          setProgress(
            response.latest_run
              ? {
                  currentEpoch: response.latest_run.logs.length,
                  totalEpochs: response.latest_run.epochs,
                  percent: Math.round((response.latest_run.logs.length / response.latest_run.epochs) * 100),
                  status: 'READY',
                }
              : EMPTY_PROGRESS,
          );
        });
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof ApiError ? error.message : '训练数据加载失败。');
        setStatusMessage('训练环境加载失败。');
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    loadTrainingBootstrap();

    return () => {
      isActive = false;
    };
  }, [session?.session_token]);

  const sampleCount = bootstrap?.samples?.length || 0;
  const modelConfig = bootstrap?.modeling_config || null;
  const lastRun = bootstrap?.latest_run || null;
  const augmentationSummary = formatAugmentationModes(augmentationModes);
  const lastRunAugmentationSummary = formatAugmentationModes(lastRun?.augmentation_modes || []);
  const currentLoss = metrics.loss.at(-1) ?? lastRun?.final_loss ?? null;
  const currentAccuracy = metrics.accuracy.at(-1) ?? lastRun?.final_accuracy ?? null;
  const currentValAccuracy = metrics.valAccuracy.at(-1) ?? lastRun?.final_val_accuracy ?? null;
  const currentValLoss = metrics.valLoss.at(-1) ?? lastRun?.final_val_loss ?? null;
  const canTrain =
    Boolean(trainingUnlocked) &&
    !isLoading &&
    !isTraining &&
    sampleCount > 0 &&
    Boolean(modelConfig);
  const progressSegments = useMemo(
    () => Array.from({ length: Math.max(epochs, 1) }, (_, index) => index < progress.currentEpoch),
    [epochs, progress.currentEpoch],
  );

  useEffect(() => {
    trainingRef.current = isTraining;
  }, [isTraining]);

  useEffect(() => {
    onTrainingStateChange?.(isTraining);
  }, [isTraining, onTrainingStateChange]);

  useEffect(() => () => onTrainingStateChange?.(false), [onTrainingStateChange]);

  async function handleStartTraining() {
    if (!bootstrap || !modelConfig || trainingRef.current) {
      return;
    }

    let xs = null;
    let ys = null;
    let trainingXs = null;
    let trainingYs = null;
    let model = null;

    setIsTraining(true);
    setErrorMessage('');
    setMetrics(createEmptyMetrics());
    setLogFeed([createLogLine('正在初始化 TensorFlow.js 环境...')]);
    setProgress({
      currentEpoch: 0,
      totalEpochs: epochs,
      percent: 0,
      status: 'RUNNING',
    });
    setStatusMessage('准备本地训练任务...');

    try {
      await ensureCpuBackend();
      setLogFeed((current) => [...current, createLogLine(`训练后端已切换到 ${tf.getBackend().toUpperCase()}.`)]);
      setStatusMessage('正在准备训练数据...');

      const shuffledSamples = [...bootstrap.samples];
      tf.util.shuffle(shuffledSamples);

      const dataset = await createDatasetTensors(shuffledSamples);
      ({ xs, ys } = dataset);
      const trainingDataset = buildAugmentedDataset(xs, ys, augmentationModes, augmentCopies);
      trainingXs = trainingDataset.xs;
      trainingYs = trainingDataset.ys;
      setLogFeed((current) => [
        ...current.slice(-(LOG_LIMIT - 1)),
        createLogLine(
          `${dataset.usableSampleCount} 条样本已载入${dataset.skippedSampleCount ? `，跳过 ${dataset.skippedSampleCount} 条异常样本` : ''}。增强: ${augmentationSummary}，有效训练集 ${trainingDataset.effectiveSampleCount} 条。`,
        ),
      ]);

      model = buildTfModel(modelConfig.hidden_layers, learningRate);
      const epochLogs = [];
      const validationSplit = dataset.usableSampleCount >= 10 ? 0.2 : 0;

      setStatusMessage('模型正在训练中...');

      await model.fit(trainingXs, trainingYs, {
        batchSize,
        epochs,
        shuffle: true,
        validationSplit,
        callbacks: {
          onEpochEnd: async (epochIndex, logs) => {
            const loss = getMetricValue(logs, 'loss', 'loss');
            const accuracy = getMetricValue(logs, 'acc', 'accuracy');
            const valLoss = getMetricValue(logs, 'val_loss', 'valLoss');
            const valAccuracy = getMetricValue(logs, 'val_acc', 'val_accuracy');
            const metricPoint = {
              epoch: epochIndex + 1,
              loss: loss ?? 0,
              accuracy: accuracy ?? 0,
              val_loss: valLoss,
              val_accuracy: valAccuracy,
            };

            epochLogs.push(metricPoint);
            startTransition(() => {
              setMetrics((current) => ({
                loss: [...current.loss, metricPoint.loss],
                accuracy: [...current.accuracy, metricPoint.accuracy],
                valLoss:
                  typeof metricPoint.val_loss === 'number'
                    ? [...current.valLoss, metricPoint.val_loss]
                    : current.valLoss,
                valAccuracy:
                  typeof metricPoint.val_accuracy === 'number'
                    ? [...current.valAccuracy, metricPoint.val_accuracy]
                    : current.valAccuracy,
              }));
              setLogFeed((current) => [
                ...current.slice(-(LOG_LIMIT - 1)),
                createLogLine(
                  `Epoch ${metricPoint.epoch}/${epochs} complete | loss ${metricPoint.loss.toFixed(4)} | acc ${toDisplayPercent(
                    metricPoint.accuracy,
                  )}${typeof metricPoint.val_accuracy === 'number' ? ` | val ${toDisplayPercent(metricPoint.val_accuracy)}` : ''}`,
                ),
              ]);
              setProgress({
                currentEpoch: metricPoint.epoch,
                totalEpochs: epochs,
                percent: Math.round((metricPoint.epoch / epochs) * 100),
                status: 'RUNNING',
              });
            });
            await tf.nextFrame();
          },
        },
      });

      const finalPoint = epochLogs.at(-1);
      const savedRun = await saveTrainingRun({
        batch_size: batchSize,
        epochs,
        learning_rate: learningRate,
        trained_sample_count: dataset.usableSampleCount,
        augmentation_modes: augmentationModes,
        augment_copies: augmentationModes.length ? augmentCopies : 1,
        backend: 'cpu',
        final_loss: finalPoint?.loss ?? null,
        final_accuracy: finalPoint?.accuracy ?? null,
        final_val_loss: finalPoint?.val_loss ?? null,
        final_val_accuracy: finalPoint?.val_accuracy ?? null,
        logs: epochLogs,
      }, session?.session_token);
      await model.save(getStoredModelKey(bootstrap.user_id));

      setBootstrap((current) => (current ? { ...current, latest_run: savedRun } : current));
      setStatusMessage('训练完成，模型与日志已保存。');
      setProgress({
        currentEpoch: epochs,
        totalEpochs: epochs,
        percent: 100,
        status: 'COMPLETE',
      });
      setLogFeed((current) => [
        ...current.slice(-(LOG_LIMIT - 1)),
        createLogLine(
          `训练结束 | 样本 ${dataset.usableSampleCount} | 增强 ${augmentationSummary} | 最终 acc ${toDisplayPercent(savedRun.final_accuracy)}${
            typeof savedRun.final_val_accuracy === 'number'
              ? ` | val ${toDisplayPercent(savedRun.final_val_accuracy)}`
              : ''
          }`,
        ),
      ]);
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : error.message || '训练失败。');
      setStatusMessage('训练中断，请检查记录后重试。');
      setProgress((current) => ({ ...current, status: 'ERROR' }));
      setLogFeed((current) => [
        ...current.slice(-(LOG_LIMIT - 1)),
        createLogLine(error instanceof ApiError ? error.message : error.message || '训练过程发生错误。'),
      ]);
    } finally {
      xs?.dispose();
      ys?.dispose();
      if (trainingXs && trainingXs !== xs) {
        trainingXs.dispose();
      }
      if (trainingYs && trainingYs !== ys) {
        trainingYs.dispose();
      }
      model?.dispose();
      setIsTraining(false);
    }
  }

  return (
    <AppChrome
      activeSection="training"
      session={session}
      competitionTimer={competitionTimer}
      onResetExperiment={onResetExperiment}
      trainingUnlocked={trainingUnlocked}
      isTrainingActive={isTrainingActive}
    >
      <main className="training-main">
        <div className="training-backdrop" aria-hidden="true">
          <span className="material-symbols-outlined">analytics</span>
        </div>

        <div className="training-shell">
          <header className="training-header">
            <h1>
              本地训练 <span>LIVE_CPU</span>
            </h1>
            <div className="training-header-tags">
              <span>{`STATUS: ${progress.status}`}</span>
              <span>{`SAMPLES: ${sampleCount}`}</span>
              <span>{`PARAMS: ${modelConfig?.summary?.param_count?.toLocaleString?.() || '--'}`}</span>
              <span>{`BACKEND: ${isTraining ? 'CPU' : lastRun?.backend?.toUpperCase() || 'CPU'}`}</span>
            </div>
          </header>

          <div className="training-grid">
            <section className="training-controls">
              <div className="training-card training-card-params">
                <div className="training-card-code">TRAIN MODE</div>
                <h2>
                  <span className="material-symbols-outlined">settings_input_component</span>
                  超参数
                </h2>

                <div className="training-form">
                  <div className="training-param-grid">
                    <label>
                      <span>batch size</span>
                      <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} disabled={isTraining}>
                        {BATCH_SIZE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>epochs</span>
                      <select value={epochs} onChange={(event) => setEpochs(Number(event.target.value))} disabled={isTraining}>
                        {EPOCH_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>learning rate</span>
                      <select
                        value={learningRate}
                        onChange={(event) => setLearningRate(Number(event.target.value))}
                        disabled={isTraining}
                      >
                        {LEARNING_RATE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>AUG COPIES</span>
                      <select
                        value={augmentCopies}
                        onChange={(event) => setAugmentCopies(Number(event.target.value))}
                        disabled={isTraining || !augmentationModes.length}
                      >
                        {AUGMENT_COPIES_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="training-multiselect">
                    <span className="training-multiselect-title">数据增强</span>
                    <div className="training-augmentation-list">
                      {AUGMENTATION_OPTIONS.map((option) => {
                        const checked = augmentationModes.includes(option.value);
                        return (
                          <label
                            key={option.value}
                            className={checked ? 'training-augmentation-option training-augmentation-option-active' : 'training-augmentation-option'}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isTraining}
                              className="training-augmentation-input"
                              onChange={() => {
                                setAugmentationModes((current) =>
                                  current.includes(option.value)
                                    ? current.filter((item) => item !== option.value)
                                    : [...current, option.value],
                                );
                              }}
                            />
                            <strong>{AUGMENTATION_LABELS[option.value] || option.label}</strong>
                          </label>
                        );
                      })}
                    </div>
                    <div className="training-selection-summary">{`当前：${augmentationSummary}`}</div>
                  </div>

                  <button type="button" className="training-start-button" onClick={handleStartTraining} disabled={!canTrain}>
                    {isTraining ? '训练中...' : '开始冲刺'}
                  </button>
                </div>
              </div>

              <div className="gpu-card">
                <div className="gpu-head">
                  <span>运行环境</span>
                  <strong>CPU</strong>
                </div>
                <div className="gpu-meter">
                  <div className="gpu-meter-fill gpu-meter-fill-cpu" />
                </div>
                <p className="gpu-footnote">当前使用 TensorFlow.js 浏览器端 CPU 后端。</p>
              </div>

              <div className="training-card dataset-card">
                <div className="dataset-item">
                  <span>样本数</span>
                  <strong>{sampleCount.toLocaleString()}</strong>
                </div>
                <div className="dataset-item">
                  <span>隐藏层</span>
                  <strong>{modelConfig?.summary?.hidden_layer_count ?? 0}</strong>
                </div>
                <div className="dataset-item">
                  <span>内存预估</span>
                  <strong>{modelConfig?.summary?.estimated_memory_mb ?? '--'} MB</strong>
                </div>
                <div className="dataset-item">
                  <span>最近增强</span>
                  <strong>{lastRunAugmentationSummary}</strong>
                </div>
              </div>
            </section>

            <section className="training-charts">
              <article className="training-card chart-card">
                <div className="chart-head">
                  <h3>
                    Loss
                  </h3>
                  <span>{`当前：${toDisplayMetric(currentLoss)}`}</span>
                </div>
                <div className="loss-chart">
                  <div className="loss-grid" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  {metrics.loss.length ? (
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                      <polyline points={toChartPoints(metrics.loss)} />
                    </svg>
                  ) : (
                    <div className="chart-empty">等待 loss 数据</div>
                  )}
                </div>
              </article>

              <article className="training-card chart-card">
                <div className="chart-head">
                  <h3 className="chart-title-primary">
                    Accuracy
                  </h3>
                  <span className="chart-target">{`当前：${toDisplayPercent(currentValAccuracy ?? currentAccuracy)}`}</span>
                </div>

                <div className="accuracy-chart">
                  <div className="accuracy-watermark">{toDisplayPercent(currentValAccuracy ?? currentAccuracy)}</div>
                  {metrics.accuracy.length ? (
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                      <polyline points={toChartPoints(metrics.valAccuracy.length ? metrics.valAccuracy : metrics.accuracy)} />
                    </svg>
                  ) : (
                    <div className="chart-empty">等待训练结果</div>
                  )}
                </div>

                <div className="metric-grid">
                  <div className="metric-tile">
                    <span>训练 Acc</span>
                    <strong>{toDisplayPercent(currentAccuracy)}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>验证 Acc</span>
                    <strong>{toDisplayPercent(currentValAccuracy)}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>验证 Loss</span>
                    <strong>{toDisplayMetric(currentValLoss)}</strong>
                  </div>
                  <div className="metric-tile">
                    <span>最近更新</span>
                    <strong>{lastRun?.updated_at ? new Date(lastRun.updated_at).toLocaleTimeString() : '--'}</strong>
                  </div>
                </div>
              </article>

              <article className="training-card progress-card">
                <div className="progress-headline">
                  <div>
                    <div className="progress-title">
                      {`ROUND_${String(progress.currentEpoch).padStart(2, '0')}`} <span>{`/ ${progress.totalEpochs || epochs}`}</span>
                    </div>
                    <div className="progress-subtitle">{statusMessage}</div>
                  </div>
                  <div className="progress-summary">
                    <strong>{`${progress.percent}%`}</strong>
                    <span>{`模式：${isTraining ? 'LIVE_CPU' : 'STANDBY'}`}</span>
                  </div>
                </div>

                <div
                  className="progress-segments"
                  style={{ gridTemplateColumns: `repeat(${Math.max(progressSegments.length, 1)}, minmax(0, 1fr))` }}
                >
                  {progressSegments.map((isActive, index) => (
                    <div
                      key={index}
                      className={isActive ? 'progress-segment progress-segment-active' : 'progress-segment'}
                    />
                  ))}
                </div>

                {errorMessage ? <div className="training-banner training-banner-error">{errorMessage}</div> : null}
                {!errorMessage && !trainingUnlocked ? (
                  <div className="training-banner training-banner-warning">
                    标注数量未达标，暂时不能开始训练。
                  </div>
                ) : null}
                {!errorMessage && sampleCount === 0 ? (
                  <div className="training-banner training-banner-warning">
                    当前没有可训练样本，请先去标注页提交数据。
                  </div>
                ) : null}

                <div className="training-log-list">
                  {logFeed.map(([time, message]) => (
                    <div key={`${time}-${message}`} className="training-log-line">
                      <span>{time}</span>
                      <span>{message}</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </div>
        </div>
      </main>
    </AppChrome>
  );
}

export default TrainingPage;
