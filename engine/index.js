/**
 * NexGate — Prediction Engine Entry Point (index.js)
 * ===================================================
 * Loads env, initializes Firebase Admin + Gemini,
 * runs staggered prediction loop across all 8 zones.
 *
 * Staggered loop: one zone every ~7.5 seconds = full cycle in ~60 seconds.
 * This avoids Gemini rate limit issues vs firing all 8 simultaneously.
 *
 * Usage:
 *   cd engine
 *   npm install
 *   node index.js
 */

import dotenv from 'dotenv';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localEnvPath = path.join(__dirname, '.env');
const parentEnvPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: fs.existsSync(localEnvPath) ? localEnvPath : parentEnvPath });
import { initGemini, predictZone, recordReading } from './predictor.js';
import {
  initAlertManager,
  processAlert,
  getActiveAlertCount,
} from './alertManager.js';
import { initChatServer } from './server.js';

// ─── Configuration ───────────────────────────────────────────────
const ZONE_INTERVAL_MS = 15000; // 15 seconds between zone predictions (free-tier safe)
const defaultZonesPath = fs.existsSync(path.join(__dirname, 'zones_config.json'))
  ? path.join(__dirname, 'zones_config.json')
  : path.join(__dirname, '..', 'simulator', 'zones_config.json');

const defaultEventsPath = fs.existsSync(path.join(__dirname, 'event_schedule.json'))
  ? path.join(__dirname, 'event_schedule.json')
  : path.join(__dirname, '..', 'simulator', 'event_schedule.json');

const ZONES_CONFIG_PATH = defaultZonesPath;
const EVENT_SCHEDULE_PATH = defaultEventsPath;

// ─── Load zone + event configs ───────────────────────────────────
let zones = [];
let events = [];

try {
  zones = JSON.parse(fs.readFileSync(ZONES_CONFIG_PATH, 'utf-8')).zones;
  events = JSON.parse(fs.readFileSync(EVENT_SCHEDULE_PATH, 'utf-8')).events;
  console.log(`[OK] Loaded ${zones.length} zones and ${events.length} events`);
} catch (err) {
  console.error(`[FATAL] Could not load zone/event configs: ${err.message}`);
  process.exit(1);
}

// ─── Concession stands ──────────────────────────────────────────────────────
const CONCESSION_STANDS = [
  { id: 'stand_a', name: 'Stand A', base_load: 30, lanes_total: 4 },
  { id: 'stand_b', name: 'Stand B', base_load: 25, lanes_total: 3 },
  { id: 'stand_c', name: 'Stand C', base_load: 35, lanes_total: 4 },
  { id: 'stand_d', name: 'Stand D', base_load: 20, lanes_total: 3 },
  { id: 'express',  name: 'Express Kiosk', base_load: 15, lanes_total: 2 },
];

// ─── Built-in Simulator (ported from simulator.py) ───────────────────────────
// Generates realistic sensor readings every 15s so the engine is fully
// self-contained on Cloud Run without needing the Python simulator.
let simulatorStartTime = null;

function getElapsedMinutes() {
  if (!simulatorStartTime) return 0;
  const rawMinutes = (Date.now() - simulatorStartTime) / 60000;
  const speed = parseInt(process.env.SIMULATION_SPEED || '1', 10);
  return (rawMinutes * speed) % 120; // Loop seamlessly every 120 minutes
}

function getActiveEvent(elapsedMinutes) {
  let active = null;
  for (const event of events) {
    const offset = event.time_offset_min;
    if (offset <= elapsedMinutes && elapsedMinutes <= offset + 10) {
      if (!active || event.surge_multiplier > active.surge_multiplier) {
        active = event;
      }
    }
  }
  return active;
}

export function calculateZoneDensity(zone, elapsedMinutes, activeEvent) {
  let density = zone.base_load;
  density += Math.sin(elapsedMinutes * 0.1) * 8; // sinusoidal variation ±8%
  density += (Math.random() - 0.5) * 10;          // random noise ±5%

  if (activeEvent && Array.isArray(activeEvent.surge_zones) && activeEvent.surge_zones.includes(zone.id)) {
    const timeIntoEvent = elapsedMinutes - activeEvent.time_offset_min;
    let surge = 0;
    if (timeIntoEvent < 3) {
      surge = (activeEvent.surge_multiplier - 1.0) * (timeIntoEvent / 3.0);
    } else if (timeIntoEvent < 7) {
      surge = activeEvent.surge_multiplier - 1.0;
    } else {
      const fade = (10 - timeIntoEvent) / 3.0;
      surge = (activeEvent.surge_multiplier - 1.0) * Math.max(0, fade);
    }
    density *= (1.0 + surge);
  }
  return Math.round(Math.max(0, Math.min(100, density)) * 10) / 10;
}

export function calculateQueueLength(density, capacity) {
  if (density < 50) return Math.floor(Math.random() * capacity * 0.02);
  if (density < 70) return Math.floor(capacity * 0.02 + Math.random() * capacity * 0.06);
  if (density < 85) return Math.floor(capacity * 0.08 + Math.random() * capacity * 0.07);
  return Math.floor(capacity * 0.15 + Math.random() * capacity * 0.10);
}

export function calculateConcessionData(stand, elapsedMinutes, activeEvent) {
  const isHalftime = activeEvent && activeEvent.label && activeEvent.label.includes('Halftime');
  let load, lanesOpen, predictedSurge;

  if (isHalftime) {
    load = Math.min(100, stand.base_load * 2.5 + (Math.random() - 0.5) * 15);
    lanesOpen = stand.lanes_total;
    predictedSurge = true;
  } else {
    load = stand.base_load + (Math.random() - 0.5) * 25;
    load = Math.max(5, Math.min(95, load));
    lanesOpen = Math.max(1, Math.round(stand.lanes_total * (load / 100)));
    predictedSurge = elapsedMinutes > 35 && elapsedMinutes < 45;
  }
  const waitMinutes = Math.max(0.5, Math.round((load / 100 * 18 + (Math.random() - 0.5) * 4) * 10) / 10);
  return { load_percent: Math.round(load * 10) / 10, lanes_open: lanesOpen, wait_minutes: waitMinutes, predicted_surge: predictedSurge };
}

async function runSimulatorTick() {
  const elapsedMinutes = getElapsedMinutes();
  const activeEvent = getActiveEvent(elapsedMinutes);
  const now = new Date().toISOString();
  const updates = {};

  for (const zone of zones) {
    const density = calculateZoneDensity(zone, elapsedMinutes, activeEvent);
    const queue_length = calculateQueueLength(density, zone.capacity);
    updates[`zones/${zone.id}/current`] = { density, queue_length, timestamp: now };
  }
  for (const stand of CONCESSION_STANDS) {
    updates[`concessions/${stand.id}`] = calculateConcessionData(stand, elapsedMinutes, activeEvent);
  }

  try {
    await db.ref('/').update(updates);
    console.log(`[SIM] t=${elapsedMinutes.toFixed(1)}min | ${activeEvent ? activeEvent.label : 'Normal ops'} | ${zones.length} zones updated`);
  } catch (err) {
    console.error(`[SIM] Firebase write failed: ${err.message}`);
  }
}

// ─── Firebase initialization ─────────────────────────────────────
let db = null;

function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  const defaultCredPath = fs.existsSync(path.join(__dirname, 'serviceAccountKey.json')) 
    ? path.join(__dirname, 'serviceAccountKey.json')
    : path.join(__dirname, '..', 'serviceAccountKey.json');
    
  const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || defaultCredPath;

  if (!dbUrl) {
    console.error('[FATAL] FIREBASE_DATABASE_URL not set in .env');
    process.exit(1);
  }

  try {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      // 1. Prioritize raw JSON string injected via Cloud Run env vars
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
      console.log('[OK] Loaded Firebase credentials from FIREBASE_SERVICE_ACCOUNT_JSON env var');
    } else if (fs.existsSync(credPath)) {
      // 2. Fall back to local file
      const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      credential = admin.credential.cert(serviceAccount);
      console.log(`[OK] Loaded Firebase credentials from ${credPath}`);
    } else {
      // 3. Fall back to application default credentials (ADC)
      credential = admin.credential.applicationDefault();
      console.log('[WARN] No service account file or JSON env var found — using ADC');
    }

    admin.initializeApp({
      credential,
      databaseURL: dbUrl,
      projectId,
    });

    db = admin.database();
    console.log(`[OK] Firebase connected: ${dbUrl}`);
    return db;
  } catch (err) {
    console.error(`[FATAL] Firebase init failed: ${err.message}`);
    process.exit(1);
  }
}

// ─── Event context determination ─────────────────────────────────
const engineStartTime = Date.now();

function getEventContext() {
  // Calculate simulated elapsed minutes
  const speed = parseInt(process.env.SIMULATION_SPEED || '1', 10);
  const realElapsed = (Date.now() - engineStartTime) / 1000;
  const rawMinutes = (realElapsed * speed) / 60;
  const elapsedMinutes = rawMinutes % 120; // Loop seamlessly every 120 minutes

  // Find upcoming or active event
  let context = 'Match in progress';

  for (const event of events) {
    const minutesUntil = event.time_offset_min - elapsedMinutes;

    if (minutesUntil > 0 && minutesUntil <= 15) {
      context = `${event.label} in ${Math.round(minutesUntil)} minutes`;
      break;
    } else if (minutesUntil <= 0 && minutesUntil > -10) {
      context = `${event.label} — currently active`;
      break;
    }
  }

  return { context, elapsedMinutes };
}

// ─── Zone data listener ──────────────────────────────────────────
function startZoneListeners() {
  for (const zone of zones) {
    const zoneRef = db.ref(`zones/${zone.id}/current`);

    zoneRef.on('value', (snapshot) => {
      const data = snapshot.val();
      if (data) {
        // Record reading for prediction history
        recordReading(zone.id, {
          density: data.density,
          queue_length: data.queue_length,
          timestamp: data.timestamp,
        });
      }
    });
  }
  console.log(`[OK] Zone listeners active on ${zones.length} zones`);
}

// ─── Staggered prediction loop ───────────────────────────────────
let cycleCount = 0;

async function runPredictionCycle() {
  cycleCount++;
  const { context, elapsedMinutes } = getEventContext();

  console.log(
    `\n── Prediction cycle #${cycleCount} ` +
    `(t=${elapsedMinutes.toFixed(1)}min, ${context}) ──`
  );

  // Publish event context to Firebase so the dashboard badge stays current
  try {
    await db.ref('system/event_context').set(context);
  } catch (e) {
    console.warn('[Engine] Could not write event_context to Firebase:', e.message);
  }

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];

    try {
      // Predict
      const prediction = await predictZone(zone, context);

      if (prediction) {
        // Write prediction to Firebase
        try {
          await db.ref(`zones/${zone.id}/predictions`).update({
            next_10m: {
              density: prediction.predicted_density_10m,
              queue: prediction.predicted_queue_10m,
              risk: prediction.risk_level,
              action: prediction.recommended_action,
              confidence: prediction.confidence,
            },
            next_15m: {
              density: prediction.predicted_density_15m,
              queue: prediction.predicted_queue_10m, // approximate
              risk: prediction.risk_level,
              action: prediction.recommended_action,
              confidence: prediction.confidence,
            },
          });
        } catch (writeErr) {
          console.error(
            `  [${zone.id}] Firebase write failed: ${writeErr.message}`
          );
        }

        // Process alert
        try {
          await processAlert(zone, prediction);
        } catch (alertErr) {
          console.error(
            `  [${zone.id}] Alert processing failed: ${alertErr.message}`
          );
        }
      }
    } catch (err) {
      console.error(`  [${zone.id}] Prediction failed: ${err.message}`);
    }

    // Stagger: wait 7.5s before processing next zone
    // (unless it's the last zone in the cycle)
    if (i < zones.length - 1) {
      await sleep(ZONE_INTERVAL_MS);
    }
  }

  console.log(
    `── Cycle #${cycleCount} complete. ` +
    `Active alerts: ${getActiveAlertCount()} ──\n`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Smart Heartbeat Logic ───────────────────────────────────────
let lastClientTimestamp = 0;
let lastHeartbeatReceivedServerTime = Date.now();
let isSleeping = false;
let sleepResolve = null;

function startHeartbeatListener() {
  const hbRef = db.ref('system/last_active');
  hbRef.on('value', (snap) => {
    const val = snap.val();
    // BUG FIX: Ignore false wake-ups from identical timestamps
    if (val && val > lastClientTimestamp) {
      const wasIdle = Date.now() - lastHeartbeatReceivedServerTime > 5 * 60 * 1000;
      lastClientTimestamp = val;
      lastHeartbeatReceivedServerTime = Date.now(); // Record server's local time
      if (wasIdle && isSleeping && sleepResolve) {
        console.log(
          `\n[WAKE UP] Dashboards active. Resuming high-frequency operational scan.`
        );
        isSleeping = false;
        sleepResolve(); // Resolves the sleep Promise instantly!
        sleepResolve = null;
      }
    }
  });
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  NexGate Prediction Engine');
  console.log(
    `  Zones: ${zones.length} | Stagger: ${ZONE_INTERVAL_MS / 1000}s per zone`
  );
  console.log(
    `  Full cycle: ~${((zones.length * ZONE_INTERVAL_MS) / 1000).toFixed(0)}s`
  );
  console.log('='.repeat(60));

  // Initialize Firebase
  initFirebase();

  // Initialize Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    initGemini(geminiKey);
  } else {
    console.log(
      '[WARN] GEMINI_API_KEY not set — running in fallback mode (moving average)'
    );
  }

  // Initialize alert manager
  initAlertManager(db);

  // Initialize Chat Proxy Server
  // Falls back to GEMINI_API_KEY if dedicated chatbot key is not set,
  // since both services can share the same API key on the free tier.
  const chatbotKey =
    process.env.GEMINI_API_KEY_CHATBOT || process.env.GEMINI_API_KEY;
  if (chatbotKey) {
    initChatServer(chatbotKey);
  } else {
    // Start server anyway so the dashboard gets a clean 503 instead of
    // a TCP connection-refused error that is hard to debug.
    console.warn(
      '[WARN] No Gemini key found — Chat Server will start but return 503 on requests.'
    );
    initChatServer(null);
  }

  // Start listening for zone data updates and heartbeats
  startZoneListeners();
  startHeartbeatListener();

  // ── Start built-in simulator ──────────────────────────────────────────────
  simulatorStartTime = Date.now();
  console.log('[SIM] Built-in simulator started — writing zone + concession data every 15s');
  await runSimulatorTick(); // first tick immediately so predictions have fresh data
  setInterval(runSimulatorTick, 15000);

  // Short wait so first tick is recorded before prediction cycle reads it
  await sleep(3000);

  // Run prediction loop indefinitely
  console.log('[START] Prediction loop starting');

  while (true) {
    try {
      await runPredictionCycle();
    } catch (err) {
      console.error(`[ERROR] Prediction cycle failed: ${err.message}`);
    }

    // Smart Sleep Logic
    // BUG FIX: Use the server's own clock to calculate idle time, avoiding client clock-drift issues
    const timeSinceActive = Date.now() - lastHeartbeatReceivedServerTime;
    const isIdle = timeSinceActive > 5 * 60 * 1000; // 5 mins

    if (isIdle) {
      console.log(
        `\n[HIBERNATION] System idle. Entering high-efficiency standby mode...`
      );
      isSleeping = true;
      await new Promise((resolve) => {
        sleepResolve = resolve;
        setTimeout(resolve, 30 * 60 * 1000); // Wait up to 30 mins
      });
      isSleeping = false;
      sleepResolve = null;
    } else {
      // Small gap between normal cycles
      await sleep(2000);
    }
  }
}

// ─── Graceful shutdown ───────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[STOP] Engine stopped by user.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[STOP] Engine terminated.');
  process.exit(0);
});

// ─── Launch ──────────────────────────────────────────────────────
main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
