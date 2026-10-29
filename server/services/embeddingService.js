import axios from 'axios';

export const EMBEDDING_CONFIG = {
  model: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
  dimension: parseInt(process.env.EMBEDDING_DIMENSION || '768', 10),
  batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || '30', 10),
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * Sleep helper for exponential backoff.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates an embedding for a single text query with retry logic.
 * @param {string} text - Input text
 * @returns {Promise<number[]>} - Float vector array
 */
export async function generateQueryEmbedding(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Text to embed cannot be empty.');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is missing.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_CONFIG.model}:embedContent?key=${apiKey}`;

  let attempts = 0;
  while (attempts < EMBEDDING_CONFIG.maxRetries) {
    try {
      const response = await axios.post(
        url,
        {
          content: { parts: [{ text: text.trim() }] },
          outputDimensionality: EMBEDDING_CONFIG.dimension,
        },
        { timeout: 15000 }
      );

      const values = response.data?.embedding?.values;
      if (!values || !Array.isArray(values)) {
        throw new Error('Malformed embedding response from API.');
      }

      return values;
    } catch (err) {
      attempts++;
      const isRateLimit = err.response?.status === 429 || err.response?.data?.error?.code === 429;
      if (attempts >= EMBEDDING_CONFIG.maxRetries || (!isRateLimit && err.response?.status >= 400 && err.response?.status < 500)) {
        const errorDetail = err.response?.data?.error?.message || err.message;
        throw new Error(`Embedding generation failed (${err.response?.status || 'network'}): ${errorDetail}`);
      }
      // Exponential backoff
      await sleep(EMBEDDING_CONFIG.retryDelayMs * Math.pow(2, attempts - 1));
    }
  }
}

/**
 * Generates embeddings for an array of text chunks using batching.
 * @param {string[]} texts - Array of chunk strings
 * @returns {Promise<number[][]>} - Array of float vector arrays
 */
export async function generateBatchEmbeddings(texts) {
  if (!texts || !Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is missing.');
  }

  const allEmbeddings = [];
  const batchSize = EMBEDDING_CONFIG.batchSize;
  const batchUrl = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_CONFIG.model}:batchEmbedContents?key=${apiKey}`;

  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const requests = slice.map((t) => ({
      model: `models/${EMBEDDING_CONFIG.model}`,
      content: { parts: [{ text: t.trim() }] },
      outputDimensionality: EMBEDDING_CONFIG.dimension,
    }));

    let attempts = 0;
    let batchSucceeded = false;

    while (attempts < EMBEDDING_CONFIG.maxRetries && !batchSucceeded) {
      try {
        const response = await axios.post(batchUrl, { requests }, { timeout: 30000 });
        const embeddings = response.data?.embeddings;

        if (!embeddings || !Array.isArray(embeddings) || embeddings.length !== slice.length) {
          throw new Error('Incomplete batch embedding response from provider.');
        }

        for (const item of embeddings) {
          if (!item || !Array.isArray(item.values)) {
            throw new Error('Embedding batch response contained missing vector values.');
          }
          allEmbeddings.push(item.values);
        }
        batchSucceeded = true;
      } catch (err) {
        attempts++;
        const isRateLimit = err.response?.status === 429 || err.response?.data?.error?.code === 429;
        if (attempts >= EMBEDDING_CONFIG.maxRetries || (!isRateLimit && err.response?.status >= 400 && err.response?.status < 500)) {
          // If batch fails with 4xx or retries exhausted, attempt individual embeddings as fallback
          console.warn(`[Embedding Service] Batch failed at index ${i}, falling back to single embeddings...`);
          for (const itemText of slice) {
            const singleEmbedding = await generateQueryEmbedding(itemText);
            allEmbeddings.push(singleEmbedding);
          }
          batchSucceeded = true;
          break;
        }
        await sleep(EMBEDDING_CONFIG.retryDelayMs * Math.pow(2, attempts - 1));
      }
    }
  }

  return allEmbeddings;
}
