import * as tf from '@tensorflow/tfjs';

export const IMAGE_SIZE = 28;
export const MODEL_STORAGE_PREFIX = 'indexeddb://mnist-compact-model';

export function getStoredModelKey(userId) {
  return `${MODEL_STORAGE_PREFIX}-${userId}`;
}

export async function ensureCpuBackend() {
  await tf.ready();
  if (tf.getBackend() !== 'cpu') {
    await tf.setBackend('cpu');
  }
}

export function orderLayersForExecution(hiddenLayers) {
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

export function buildTfModel(hiddenLayers, learningRate) {
  const model = tf.sequential();
  const executionLayers = orderLayersForExecution(hiddenLayers);
  let flattenInserted = false;
  let firstLayer = true;

  executionLayers.forEach((layer) => {
    if (layer.type === 'conv2d') {
      model.add(
        tf.layers.conv2d({
          inputShape: firstLayer ? [IMAGE_SIZE, IMAGE_SIZE, 1] : undefined,
          filters: layer.filters,
          kernelSize: layer.kernel_size,
          activation: layer.activation,
          padding: layer.padding,
        }),
      );
      firstLayer = false;
      return;
    }

    if (layer.type === 'maxpool') {
      model.add(
        tf.layers.maxPooling2d({
          poolSize: layer.pool_size,
          strides: layer.strides,
          inputShape: firstLayer ? [IMAGE_SIZE, IMAGE_SIZE, 1] : undefined,
        }),
      );
      firstLayer = false;
      return;
    }

    if (!flattenInserted) {
      model.add(
        tf.layers.flatten({
          inputShape: firstLayer ? [IMAGE_SIZE, IMAGE_SIZE, 1] : undefined,
        }),
      );
      flattenInserted = true;
      firstLayer = false;
    }

    if (layer.type === 'dropout') {
      model.add(tf.layers.dropout({ rate: layer.rate }));
      return;
    }

    model.add(
      tf.layers.dense({
        units: layer.units,
        activation: layer.activation,
      }),
    );
  });

  if (!flattenInserted) {
    model.add(
      tf.layers.flatten({
        inputShape: firstLayer ? [IMAGE_SIZE, IMAGE_SIZE, 1] : undefined,
      }),
    );
  }

  model.add(
    tf.layers.dense({
      units: 10,
      activation: 'softmax',
    }),
  );

  model.compile({
    optimizer: tf.train.adam(learningRate),
    loss: 'categoricalCrossentropy',
    metrics: ['accuracy'],
  });

  return model;
}
