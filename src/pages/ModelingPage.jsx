import { useEffect, useMemo, useState } from 'react';
import AppChrome from '../components/AppChrome';
import { ApiError, fetchModelConfig, saveModelConfig } from '../lib/api';

const MAX_PARAM_COUNT = 200000;

const MODULE_DEFINITIONS = [
  {
    type: 'conv2d',
    name: 'Conv2D',
    detail: 'Feature extraction',
    icon: 'grid_view',
    accent: 'secondary',
    defaults: { filters: 32, kernel_size: 3, activation: 'relu', padding: 'same' },
  },
  {
    type: 'maxpool',
    name: 'MaxPooling',
    detail: 'Spatial reduction',
    icon: 'photo_filter',
    accent: 'secondary',
    defaults: { pool_size: 2, strides: 2 },
  },
  {
    type: 'dropout',
    name: 'Dropout',
    detail: 'Prevent overfitting',
    icon: 'blur_off',
    accent: 'tertiary',
    defaults: { rate: 0.25 },
  },
  {
    type: 'dense',
    name: 'Dense',
    detail: 'Fully connected',
    icon: 'hub',
    accent: 'success',
    defaults: { units: 128, activation: 'relu' },
  },
];

const FILTER_OPTIONS = [8, 16, 32, 64];
const KERNEL_OPTIONS = [3, 5];
const CONV_ACTIVATION_OPTIONS = ['relu', 'tanh'];
const PADDING_OPTIONS = ['same', 'valid'];
const POOL_SIZE_OPTIONS = [2, 3];
const STRIDE_OPTIONS = [1, 2];
const DROPOUT_OPTIONS = [0.1, 0.2, 0.25, 0.3, 0.5];
const DENSE_UNIT_OPTIONS = [32, 64, 128, 256];
const DENSE_ACTIVATION_OPTIONS = ['relu', 'tanh', 'sigmoid'];

function formatLayerId(index) {
  return `LAYER_${String(index + 1).padStart(2, '0')}`;
}

function createLayer(type, index) {
  const moduleDefinition = MODULE_DEFINITIONS.find((item) => item.type === type);
  return {
    id: `layer-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    ...moduleDefinition.defaults,
  };
}

function getModuleDefinition(type) {
  return MODULE_DEFINITIONS.find((item) => item.type === type);
}

function getInsertIndexForNewLayer(hiddenLayers, type) {
  if (!['conv2d', 'maxpool'].includes(type)) {
    return hiddenLayers.length;
  }

  const firstDenseIndex = hiddenLayers.findIndex((layer) => layer.type === 'dense');
  return firstDenseIndex === -1 ? hiddenLayers.length : firstDenseIndex;
}

function formatActivationLabel(value) {
  return value.toUpperCase();
}

function describeLayer(layer) {
  if (layer.type === 'conv2d') {
    return `Filters ${layer.filters} | Kernel ${layer.kernel_size}x${layer.kernel_size} | ${layer.padding}`;
  }

  if (layer.type === 'maxpool') {
    return `Pool ${layer.pool_size}x${layer.pool_size} | Stride ${layer.strides}`;
  }

  if (layer.type === 'dropout') {
    return `Rate ${layer.rate}`;
  }

  return `Units ${layer.units} | ${formatActivationLabel(layer.activation)}`;
}

function getExecutionLayers(hiddenLayers) {
  const featureLayers = [];
  const headLayers = [];

  hiddenLayers.forEach((layer) => {
    if (layer.type === 'conv2d' || layer.type === 'maxpool') {
      featureLayers.push(layer);
      return;
    }

    headLayers.push(layer);
  });

  return [...featureLayers, ...headLayers];
}

function calculateSummary(hiddenLayers) {
  const executionLayers = getExecutionLayers(hiddenLayers);
  let height = 28;
  let width = 28;
  let channels = 1;
  let flattenedFeatures = null;
  let totalParams = 0;
  let denseStarted = false;

  for (const layer of executionLayers) {
    if (layer.type === 'conv2d') {
      totalParams += (layer.kernel_size * layer.kernel_size * channels + 1) * layer.filters;
      if (layer.padding === 'same') {
        height = Math.max(Math.ceil(height), 1);
        width = Math.max(Math.ceil(width), 1);
      } else {
        height = Math.max(Math.floor(height - layer.kernel_size) + 1, 1);
        width = Math.max(Math.floor(width - layer.kernel_size) + 1, 1);
      }
      channels = layer.filters;
      continue;
    }

    if (layer.type === 'maxpool') {
      height = Math.max(Math.floor((height - layer.pool_size) / layer.strides) + 1, 1);
      width = Math.max(Math.floor((width - layer.pool_size) / layer.strides) + 1, 1);
      continue;
    }

    if (layer.type === 'dropout') {
      continue;
    }

    if (!denseStarted) {
      flattenedFeatures = height * width * channels;
      denseStarted = true;
    }

    totalParams += (flattenedFeatures + 1) * layer.units;
    flattenedFeatures = layer.units;
  }

  const flattenPosition = flattenedFeatures === null ? 'before_output' : 'before_first_dense';
  const finalFeatures = flattenedFeatures ?? height * width * channels;
  totalParams += (finalFeatures + 1) * 10;

  return {
    hidden_layer_count: hiddenLayers.length,
    param_count: totalParams,
    estimated_memory_mb: ((totalParams * 4) / (1024 * 1024)).toFixed(2),
    estimated_compute: `${Math.max(totalParams / 1000000, 0.01).toFixed(2)} M-ops`,
    flatten_position: flattenPosition,
    output_classes: 10,
    exceeds_limit: totalParams > MAX_PARAM_COUNT,
  };
}

function buildCanvasNodes(hiddenLayers) {
  const firstDenseIndex = hiddenLayers.findIndex((layer) => layer.type === 'dense');
  const nodes = [
    {
      id: 'fixed-input',
      name: 'Input',
      detail: 'Shape: 28 x 28 x 1',
      icon: 'input',
      accent: 'primary',
      locked: true,
    },
  ];

  hiddenLayers.forEach((layer, index) => {
    if (index === firstDenseIndex) {
      nodes.push({
        id: 'fixed-flatten',
        name: 'Flatten',
        detail: 'Auto inserted before Dense / Output',
        icon: 'horizontal_distribute',
        accent: 'tertiary',
        locked: true,
      });
    }

    const moduleDefinition = getModuleDefinition(layer.type);
    nodes.push({
      id: layer.id,
      name: moduleDefinition.name,
      detail: describeLayer(layer),
      icon: moduleDefinition.icon,
      accent: moduleDefinition.accent,
      locked: false,
      index,
    });
  });

  if (firstDenseIndex === -1) {
    nodes.push({
      id: 'fixed-flatten',
      name: 'Flatten',
      detail: 'Auto inserted before output layer',
      icon: 'horizontal_distribute',
      accent: 'tertiary',
      locked: true,
    });
  }

  nodes.push({
    id: 'fixed-output',
    name: 'Dense + Softmax',
    detail: '10 classes | Fixed output head',
    icon: 'output',
    accent: 'error',
    locked: true,
  });

  return nodes;
}

function ModelingPage({
  session,
  onResetExperiment,
  trainingUnlocked = false,
  isTrainingActive = false,
  competitionTimer,
}) {
  const [hiddenLayers, setHiddenLayers] = useState([]);
  const [savedHiddenLayers, setSavedHiddenLayers] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState('fixed-input');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [serverMeta, setServerMeta] = useState({ updated_at: null });

  useEffect(() => {
    let isActive = true;

    async function loadConfig() {
      if (!session?.session_token) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setErrorMessage('');

      try {
        const config = await fetchModelConfig(session.session_token);
        if (!isActive) {
          return;
        }

        setHiddenLayers(config.hidden_layers || []);
        setSavedHiddenLayers(config.hidden_layers || []);
        setServerMeta({ updated_at: config.updated_at });
        setSelectedNodeId((currentValue) => currentValue || 'fixed-input');
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof ApiError ? error.message : '模型配置加载失败。');
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    loadConfig();

    return () => {
      isActive = false;
    };
  }, [session?.session_token]);

  const summary = useMemo(() => calculateSummary(hiddenLayers), [hiddenLayers]);
  const canvasNodes = useMemo(() => buildCanvasNodes(hiddenLayers), [hiddenLayers]);
  const selectedLayer = hiddenLayers.find((layer) => layer.id === selectedNodeId) || null;
  const selectedCanvasNode = canvasNodes.find((node) => node.id === selectedNodeId) || canvasNodes[0];
  const hasUnsavedChanges = JSON.stringify(hiddenLayers) !== JSON.stringify(savedHiddenLayers);

  useEffect(() => {
    if (selectedNodeId && canvasNodes.some((node) => node.id === selectedNodeId)) {
      return;
    }

    setSelectedNodeId('fixed-input');
  }, [canvasNodes, selectedNodeId]);

  function handleAddLayer(type) {
    setErrorMessage('');
    setSaveMessage('');
    setHiddenLayers((currentLayers) => {
      const insertIndex = getInsertIndexForNewLayer(currentLayers, type);
      const nextLayer = createLayer(type, insertIndex);
      setSelectedNodeId(nextLayer.id);

      if (insertIndex === currentLayers.length) {
        return [...currentLayers, nextLayer];
      }

      return [
        ...currentLayers.slice(0, insertIndex),
        nextLayer,
        ...currentLayers.slice(insertIndex),
      ];
    });
  }

  function handleLayerChange(field, value) {
    if (!selectedLayer) {
      return;
    }

    setSaveMessage('');
    setErrorMessage('');
    setHiddenLayers((currentLayers) =>
      currentLayers.map((layer) =>
        layer.id === selectedLayer.id
          ? {
              ...layer,
              [field]: typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value,
            }
          : layer,
      ),
    );
  }

  function handleDeleteLayer() {
    if (!selectedLayer) {
      return;
    }

    setSaveMessage('');
    setErrorMessage('');
    setHiddenLayers((currentLayers) => currentLayers.filter((layer) => layer.id !== selectedLayer.id));
    setSelectedNodeId('fixed-input');
  }

  function handleResetLayers() {
    setHiddenLayers([]);
    setSelectedNodeId('fixed-input');
    setSaveMessage('');
    setErrorMessage('');
  }

  async function handleSaveModel() {
    if (!session?.session_token) {
      return;
    }

    if (summary.exceeds_limit) {
      setErrorMessage(`当前配置约有 ${summary.param_count.toLocaleString()} 个参数，超过 ${MAX_PARAM_COUNT.toLocaleString()} 上限。`);
      return;
    }

    setIsSaving(true);
    setErrorMessage('');
    setSaveMessage('');

    try {
      const response = await saveModelConfig({
        hidden_layers: hiddenLayers,
      }, session.session_token);

      setHiddenLayers(response.hidden_layers || []);
      setSavedHiddenLayers(response.hidden_layers || []);
      setServerMeta({ updated_at: response.updated_at });
      setSaveMessage('模型结构已保存。');
    } catch (error) {
      setErrorMessage(error instanceof ApiError ? error.message : '模型保存失败。');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AppChrome
      activeSection="modeling"
      session={session}
      competitionTimer={competitionTimer}
      onResetExperiment={onResetExperiment}
      trainingUnlocked={trainingUnlocked}
      isTrainingActive={isTrainingActive}
    >
      <main className="modeling-main">
        <section className="module-drawer">
          <div className="drawer-header">
            <h2>
              <span className="material-symbols-outlined">category</span>
              模型组件
            </h2>
            <p>输入和输出已固定，你只需编辑中间层</p>
          </div>

          <div className="module-list">
            {MODULE_DEFINITIONS.map((card) => (
              <button
                key={card.type}
                type="button"
                className={`module-card module-card-${card.accent}`}
                onClick={() => handleAddLayer(card.type)}
                disabled={isLoading}
              >
                <div className={`module-icon-box module-icon-box-${card.accent}`}>
                  <span className="material-symbols-outlined">{card.icon}</span>
                </div>
                <div className="module-copy">
                  <div>{card.name}</div>
                  <span>
                    {card.type === 'conv2d' || card.type === 'maxpool'
                      ? `${card.detail}，必要时会自动排到 Dense 前`
                      : card.detail}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="module-rules">
            <div>
              <strong>个人配置</strong>
              <span>每人模型配置独立解锁，打造你的专属王牌模型！</span>
            </div>
            <div>
              <strong>固定结构</strong>
              <span>输入固定为 28x28x1，输出固定为 Dense(10) + Softmax。</span>
            </div>
            <div>
              <strong>自动 Flatten</strong>
              <span>系统会在首个 Dense 前，或输出层前自动插入 Flatten。</span>
            </div>
            <div>
              <strong>层序规则</strong>
              <span>若在 Dense 后添加 Conv2D/MaxPooling，系统会自动挪到 Dense 前。</span>
            </div>
          </div>
        </section>

        <section className="model-canvas">
          <div className="canvas-summary">
            <div>
              <span>PLAYER</span>
              <strong>{session?.user?.username || '未知用户'}</strong>
            </div>
            <div>
              <span>PARAMS</span>
              <strong>{summary.param_count.toLocaleString()}</strong>
            </div>
            <div>
              <span>MEMORY</span>
              <strong>{summary.estimated_memory_mb} MB</strong>
            </div>
          </div>

          <div className="model-stack">
            {isLoading ? (
              <div className="canvas-empty-state">正在加载模型配置...</div>
            ) : (
              canvasNodes.map((node, index) => (
                <div key={node.id} className="model-stack-item">
                  <button
                    type="button"
                    className={selectedNodeId === node.id ? 'model-node model-node-active' : 'model-node'}
                    onClick={() => setSelectedNodeId(node.id)}
                  >
                    <div
                      className={
                        selectedNodeId === node.id
                          ? 'node-badge node-badge-active'
                          : `node-badge node-badge-${node.accent}`
                      }
                    >
                      {node.locked ? 'FIXED' : formatLayerId(node.index)}
                    </div>
                    <span className={`material-symbols-outlined node-icon node-icon-${node.accent}`}>{node.icon}</span>
                    <div className={`node-title node-title-${node.accent}`}>{node.name}</div>
                    <div className={selectedNodeId === node.id ? 'node-detail node-detail-active' : 'node-detail'}>
                      {node.detail}
                    </div>
                  </button>

                  {index < canvasNodes.length - 1 ? (
                    <div className={selectedNodeId === node.id ? 'node-connector node-connector-active' : 'node-connector'}>
                      <span className="material-symbols-outlined">arrow_downward</span>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="canvas-status">
            {errorMessage ? <div className="status-banner status-banner-error">{errorMessage}</div> : null}
            {saveMessage ? <div className="status-banner status-banner-success">{saveMessage}</div> : null}
            {!errorMessage && !saveMessage ? (
              <div className="status-banner status-banner-muted">
                当前模型有 {summary.hidden_layer_count} 个可编辑隐藏层，参数上限为 {MAX_PARAM_COUNT.toLocaleString()}。
              </div>
            ) : null}
          </div>
        </section>

        <section className="properties-panel">
          <div className="properties-header">
            <h2>组件设置</h2>
            <span>
              {selectedCanvasNode?.locked
                ? '固定节点'
                : selectedLayer
                  ? formatLayerId(hiddenLayers.findIndex((layer) => layer.id === selectedLayer.id))
                  : '未选择'}
            </span>
          </div>

          <div className="properties-body">
            <div className="properties-layer">
              <div className="properties-icon-box">
                <span className="material-symbols-outlined">{selectedCanvasNode?.icon || 'tune'}</span>
              </div>
              <div>
                <div className="properties-title">{selectedCanvasNode?.name || '未选择节点'}</div>
                <div className="properties-subtitle">
                  {selectedCanvasNode?.locked ? '固定结构，不可编辑' : '通过预设选项调整'}
                </div>
              </div>
            </div>

            {selectedLayer ? (
              <div className="properties-form">
                {selectedLayer.type === 'conv2d' ? (
                  <>
                    <label>
                      <span>Filters</span>
                      <select value={selectedLayer.filters} onChange={(event) => handleLayerChange('filters', event.target.value)}>
                        {FILTER_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Kernel Size</span>
                      <select
                        value={selectedLayer.kernel_size}
                        onChange={(event) => handleLayerChange('kernel_size', event.target.value)}
                      >
                        {KERNEL_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option} x {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Activation</span>
                      <select
                        value={selectedLayer.activation}
                        onChange={(event) => handleLayerChange('activation', event.target.value)}
                      >
                        {CONV_ACTIVATION_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {formatActivationLabel(option)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Padding</span>
                      <select value={selectedLayer.padding} onChange={(event) => handleLayerChange('padding', event.target.value)}>
                        {PADDING_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}

                {selectedLayer.type === 'maxpool' ? (
                  <>
                    <label>
                      <span>Pool Size</span>
                      <select value={selectedLayer.pool_size} onChange={(event) => handleLayerChange('pool_size', event.target.value)}>
                        {POOL_SIZE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option} x {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Strides</span>
                      <select value={selectedLayer.strides} onChange={(event) => handleLayerChange('strides', event.target.value)}>
                        {STRIDE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}

                {selectedLayer.type === 'dropout' ? (
                  <label>
                    <span>Dropout Rate</span>
                    <select value={selectedLayer.rate} onChange={(event) => handleLayerChange('rate', event.target.value)}>
                      {DROPOUT_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {selectedLayer.type === 'dense' ? (
                  <>
                    <label>
                      <span>Units</span>
                      <select value={selectedLayer.units} onChange={(event) => handleLayerChange('units', event.target.value)}>
                        {DENSE_UNIT_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Activation</span>
                      <select
                        value={selectedLayer.activation}
                        onChange={(event) => handleLayerChange('activation', event.target.value)}
                      >
                        {DENSE_ACTIVATION_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {formatActivationLabel(option)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="fixed-node-note">
                <p>{selectedCanvasNode?.detail}</p>
                <p>输入层、自动 Flatten 和输出头由系统固定，不可编辑或删除。</p>
              </div>
            )}

            <div className={summary.exceeds_limit ? 'resource-card resource-card-warning' : 'resource-card'}>
              <div className="resource-title">
                <span className="material-symbols-outlined">memory</span>
                模型规模预估
              </div>
              <div className="resource-list">
                <div>
                  <span>隐藏层数</span>
                  <strong>{summary.hidden_layer_count}</strong>
                </div>
                <div>
                  <span>参数量</span>
                  <strong>{summary.param_count.toLocaleString()}</strong>
                </div>
                <div>
                  <span>内存</span>
                  <strong>{summary.estimated_memory_mb} MB</strong>
                </div>
                <div>
                  <span>算力消耗</span>
                  <strong>{summary.estimated_compute}</strong>
                </div>
                <div>
                  <span>Flatten</span>
                  <strong>{summary.flatten_position === 'before_output' ? '输出层前' : '首个 Dense 前'}</strong>
                </div>
              </div>
              {summary.exceeds_limit ? <p className="resource-warning">参数量超出上限，当前配置无法保存。</p> : null}
            </div>

            <div className="save-meta">
              <span>上次保存</span>
              <strong>{serverMeta.updated_at ? new Date(serverMeta.updated_at).toLocaleString() : '尚未保存'}</strong>
            </div>
          </div>

          <div className="properties-actions">
            <button type="button" className="action-button action-button-danger" onClick={handleDeleteLayer} disabled={!selectedLayer}>
              删除该层
            </button>
            <button type="button" className="action-button action-button-secondary" onClick={handleResetLayers} disabled={isLoading}>
              清空结构
            </button>
            <button
              type="button"
              className="action-button action-button-primary"
              onClick={handleSaveModel}
              disabled={isSaving || isLoading || summary.exceeds_limit || !hasUnsavedChanges}
            >
              {isSaving ? '保存中...' : '保存模型'}
            </button>
          </div>
        </section>
      </main>
    </AppChrome>
  );
}

export default ModelingPage;
