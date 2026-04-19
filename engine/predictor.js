/**
 * NexGate — Gemini Prediction Engine (predictor.js)
 * =================================================
 * Reads zone sensor data from Firebase, calls Gemini 1.5 Flash,
 * writes predictions back. Processes zones in staggered fashion
 * (~7.5s apart) to avoid rate limits.
 *
 * Includes per-zone caching and moving-average fallback.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Load system prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'prompts', 'system_prompt.txt'),
  'utf-8'
);

// ─── Per-zone prediction cache (emergency fallback) ─────────────
const predictionCache = new Map();

// ─── Per-zone reading history (for moving average fallback) ─────
const readingHistory = new Map();
const MAX_HISTORY = 10;

// ─── Gemini model setup ─────────────────────────────────────────
let model = null;

export function initGemini(apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 256,
    },
  });
  console.log('[OK] Gemini model initialized (gemini-1.5-flash)');
}

/**
 * Build the user prompt for a specific zone.
 */
function buildPrompt(zone, readings, eventContext) {
  const readingLines = readings
    .map(
      (r) =>
        `- ${r.timestamp}: density=${r.density}%, queue=${r.queue_length} people`
    )
    .join('\n');

  return `Zone: ${zone.name}
Capacity: ${zone.capacity} people
Event context: ${eventContext}

Last ${readings.length} sensor readings (oldest to newest):
${readingLines}

Predict crowd conditions at this zone for the next 10 and 15 minutes.
Recommend one specific action for the operations team.`;
}

/**
 * Simple moving average fallback when Gemini is unavailable.
 */
function fallbackPrediction(zone, readings) {
  if (readings.length === 0) {
    return {
      predicted_density_10m: zone.base_load || 30,
      predicted_density_15m: zone.base_load || 30,
      predicted_queue_10m: 0,
      risk_level: 'low',
      recommended_action: 'No data available — maintain current operations.',
      confidence: 0.2,
    };
  }

  // Calculate trend from recent readings
  const densities = readings.map((r) => r.density);
  const avgDensity = densities.reduce((a, b) => a + b, 0) / densities.length;

  // Simple linear trend
  let trend = 0;
  if (densities.length >= 2) {
    trend = (densities[densities.length - 1] - densities[0]) / densities.length;
  }

  const predicted10m = Math.min(100, Math.max(0, avgDensity + trend * 4));
  const predicted15m = Math.min(100, Math.max(0, avgDensity + trend * 6));

  // Determine risk level
  let riskLevel = 'low';
  if (predicted10m >= 90) riskLevel = 'critical';
  else if (predicted10m >= 75) riskLevel = 'high';
  else if (predicted10m >= 60) riskLevel = 'medium';

  // Queue estimate
  const queueMultiplier =
    predicted10m > 85 ? 0.2 : predicted10m > 70 ? 0.1 : 0.03;
  const predictedQueue = Math.round((zone.capacity || 3000) * queueMultiplier);

  return {
    predicted_density_10m: Math.round(predicted10m * 10) / 10,
    predicted_density_15m: Math.round(predicted15m * 10) / 10,
    predicted_queue_10m: predictedQueue,
    risk_level: riskLevel,
    recommended_action:
      riskLevel === 'critical'
        ? `Critical density forecast for ${zone.name}. Deploy additional staff immediately.`
        : riskLevel === 'high'
          ? `High density forecast for ${zone.name}. Consider opening additional lanes.`
          : `${zone.name} operating within normal parameters. No action required.`,
    confidence: 0.4,
  };
}

/**
 * Store a reading in the per-zone history.
 */
export function recordReading(zoneId, reading) {
  if (!readingHistory.has(zoneId)) {
    readingHistory.set(zoneId, []);
  }
  const history = readingHistory.get(zoneId);
  history.push(reading);
  // Keep only the last MAX_HISTORY readings
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

/**
 * Get the last N readings for a zone.
 */
export function getReadings(zoneId, count = 5) {
  const history = readingHistory.get(zoneId) || [];
  return history.slice(-count);
}

/**
 * Get the cached prediction for a zone (emergency fallback).
 */
export function getCachedPrediction(zoneId) {
  return predictionCache.get(zoneId) || null;
}

/**
 * Predict crowd conditions for a single zone.
 * Calls Gemini → parses JSON → caches result.
 * Falls back to moving average if Gemini fails.
 */
export async function predictZone(zone, eventContext = 'Match in progress') {
  const readings = getReadings(zone.id);

  if (readings.length === 0) {
    console.log(`  [${zone.id}] No readings yet — skipping`);
    return null;
  }

  // Try Gemini first with exponential backoff for rate limits (429s)
  if (model) {
    let retries = 3;
    let delayMs = 1000;

    while (retries > 0) {
      try {
        const prompt = buildPrompt(zone, readings, eventContext);
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const prediction = JSON.parse(text);

        // Validate required fields
        if (
          typeof prediction.predicted_density_10m !== 'number' ||
          typeof prediction.risk_level !== 'string'
        ) {
          throw new Error('Invalid prediction schema');
        }

        // Cache successful prediction
        predictionCache.set(zone.id, {
          ...prediction,
          source: 'gemini',
          cached_at: new Date().toISOString(),
        });

        console.log(
          `  [${zone.id}] Gemini → risk=${prediction.risk_level} ` +
            `density_10m=${prediction.predicted_density_10m}% ` +
            `conf=${prediction.confidence}`
        );

        return prediction;
      } catch (err) {
        // If it's a rate limit error, back off and retry
        if (err.message.includes('429') && retries > 1) {
          console.warn(
            `  [${zone.id}] Gemini rate limit hit. Retrying in ${delayMs}ms...`
          );
          await new Promise((res) => setTimeout(res, delayMs));
          delayMs *= 2; // Exponential backoff
          retries--;
          continue;
        }

        console.warn(
          `  [${zone.id}] Gemini failed: ${err.message} — using fallback`
        );

        // Try cached prediction first
        const cached = predictionCache.get(zone.id);
        if (cached) {
          console.log(
            `  [${zone.id}] Serving cached prediction from ${cached.cached_at}`
          );
          return { ...cached, source: 'cache' };
        }

        break; // Break loop on non-retryable error
      }
    }
  }

  // Fallback: simple moving average
  const fallback = fallbackPrediction(zone, readings);
  const result = {
    ...fallback,
    source: 'fallback',
  };

  predictionCache.set(zone.id, {
    ...result,
    cached_at: new Date().toISOString(),
  });

  console.log(
    `  [${zone.id}] Fallback → risk=${result.risk_level} ` +
      `density_10m=${result.predicted_density_10m}%`
  );

  return result;
}
