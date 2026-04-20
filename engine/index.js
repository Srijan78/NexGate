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
dotenv.config({ path: path.join(__dirname, '..', '.env') });
import { initGemini, predictZone, recordReading } from './predictor.js';
import {
  initAlertManager,
  processAlert,
  getActiveAlertCount,
} from './alertManager.js';
import { initChatServer } from './server.js';

// ─── Configuration ───────────────────────────────────────────────
const ZONE_INTERVAL_MS = 15000; // 15 seconds between zone predictions (free-tier safe)
const ZONES_CONFIG_PATH = path.join(
  __dirname,
  '..',
  'simulator',
  'zones_config.json'
);
const EVENT_SCHEDULE_PATH = path.join(
  __dirname,
  '..',
  'simulator',
  'event_schedule.json'
);

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

// ─── Firebase initialization ─────────────────────────────────────
let db = null;

function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  const credPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, '..', 'serviceAccountKey.json');

  if (!dbUrl) {
    console.error('[FATAL] FIREBASE_DATABASE_URL not set in .env');
    process.exit(1);
  }

  try {
    let credential;
    if (fs.existsSync(credPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      credential = admin.credential.cert(serviceAccount);
    } else {
      // Try default credentials (for Cloud Run / app-default-credentials)
      credential = admin.credential.applicationDefault();
      console.log(
        '[WARN] No service account file — using application default credentials'
      );
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
  const elapsedMinutes = (realElapsed * speed) / 60;

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
let lastActiveTimestamp = 0;
let isSleeping = false;
let sleepResolve = null;

function startHeartbeatListener() {
  const hbRef = db.ref('system/last_active');
  hbRef.on('value', (snap) => {
    const val = snap.val();
    if (val) {
      const wasIdle = Date.now() - lastActiveTimestamp > 15 * 60 * 1000;
      lastActiveTimestamp = val;
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

  // Wait for Firebase listeners to receive their first batch of zone readings
  // before starting predictions, so we have real data on cycle #1.
  console.log('[...] Waiting 30s for initial zone readings to arrive from the simulator...');
  await sleep(30000);

  // Run prediction loop indefinitely
  console.log('[START] Prediction loop starting');

  while (true) {
    try {
      await runPredictionCycle();
    } catch (err) {
      console.error(`[ERROR] Prediction cycle failed: ${err.message}`);
    }

    // Smart Sleep Logic
    const timeSinceActive = Date.now() - lastActiveTimestamp;
    const isIdle = timeSinceActive > 15 * 60 * 1000; // 15 mins

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
