/**
 * NexGate — Ops Dashboard Application (app.js)
 * ==============================================
 * Firebase listeners + DOM rendering for the ops command center.
 * Includes emergency mock data fallback when Firebase is unavailable.
 *
 * Firebase config goes in the CONFIGURE block below — inline constants,
 * not .env (this is vanilla JS with no build step — intentional for hackathon).
 */

// ═══════════════════════════════════════════════════════════════
// ═══ CONFIGURE YOUR FIREBASE HERE ═══
// Replace these placeholders with your actual Firebase project config.
// Find these values at: https://console.firebase.google.com → Project Settings
// ═══════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY_HERE',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.firebaseio.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
// ═══════════════════════════════════════════════════════════════

// ─── State ───────────────────────────────────────────────────
let firebaseApp = null;
let db = null;
let usingMockData = false;
let mockCycleInterval = null;
let alertCount = 0;

// ─── Zone config (matches simulator/zones_config.json) ────────
const ZONES = [
  { id: 'gate_north', name: 'Gate North', capacity: 3000, icon: '🚪' },
  { id: 'gate_south', name: 'Gate South', capacity: 3000, icon: '🚪' },
  { id: 'gate_east', name: 'Gate East', capacity: 2000, icon: '🚪' },
  { id: 'gate_west', name: 'Gate West', capacity: 2000, icon: '🚪' },
  { id: 'concourse_a', name: 'Concourse A', capacity: 5000, icon: '🏟️' },
  { id: 'concourse_b', name: 'Concourse B', capacity: 5000, icon: '🏟️' },
  { id: 'main_stand', name: 'Main Stand Area', capacity: 8000, icon: '🎯' },
  { id: 'exit_south', name: 'Exit Corridor South', capacity: 4000, icon: '🚶' },
];

const CONCESSION_STANDS = [
  { id: 'stand_a', name: 'Stand A' },
  { id: 'stand_b', name: 'Stand B' },
  { id: 'stand_c', name: 'Stand C' },
  { id: 'stand_d', name: 'Stand D' },
  { id: 'express', name: 'Express Kiosk' },
];

// ─── Initialize ──────────────────────────────────────────────
async function init() {
  startClock();
  renderZoneCards();
  renderConcessionBars();

  const firebaseReady = await initFirebase();

  if (firebaseReady) {
    setConnectionStatus('online', 'Live');
    startFirebaseListeners();
  } else {
    setConnectionStatus('mock', 'Mock Data');
    startMockDataMode();
  }
}

// ─── Firebase Init ────────────────────────────────────────────
async function initFirebase() {
  // Check if config has real values
  if (
    !FIREBASE_CONFIG.apiKey ||
    FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY_HERE' ||
    !FIREBASE_CONFIG.databaseURL ||
    FIREBASE_CONFIG.databaseURL.includes('YOUR_PROJECT')
  ) {
    console.log('[Dashboard] Firebase not configured — using mock data');
    return false;
  }

  try {
    const { initializeApp } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const { getDatabase } =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');

    firebaseApp = initializeApp(FIREBASE_CONFIG);
    db = getDatabase(firebaseApp);
    window._firebaseApp = firebaseApp;
    window._firebaseDb = db;
    console.log('[Dashboard] Firebase connected');
    return true;
  } catch (err) {
    console.warn('[Dashboard] Firebase init failed:', err.message);
    return false;
  }
}

// ─── Firebase Listeners ───────────────────────────────────────
async function startFirebaseListeners() {
  const {
    ref,
    onValue,
    onChildAdded,
    onChildChanged,
    query,
    orderByChild,
    equalTo,
    update,
  } =
    await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');

  // Zone data listener
  for (const zone of ZONES) {
    const zoneCurrentRef = ref(db, `zones/${zone.id}/current`);
    const zonePredRef = ref(db, `zones/${zone.id}/predictions/next_10m`);

    onValue(zoneCurrentRef, (snap) => {
      const data = snap.val();
      if (data) {
        updateZoneCard(zone.id, {
          density: data.density,
          queue_length: data.queue_length,
          timestamp: data.timestamp,
        });
      }
    });

    onValue(zonePredRef, (snap) => {
      const pred = snap.val();
      if (pred) {
        updateZonePrediction(zone.id, pred);
      }
    });
  }

  // Alert listener
  const alertsRef = ref(db, 'alerts');
  onChildAdded(alertsRef, (snap) => {
    const alert = { id: snap.key, ...snap.val() };
    if (!alert.resolved) {
      addAlertCard(alert);
    }
  });

  onChildChanged(alertsRef, (snap) => {
    const alert = { id: snap.key, ...snap.val() };
    if (alert.resolved) {
      removeAlertCard(alert.id);
    }
  });

  // Concession listener
  for (const stand of CONCESSION_STANDS) {
    const standRef = ref(db, `concessions/${stand.id}`);
    onValue(standRef, (snap) => {
      const data = snap.val();
      if (data) {
        updateConcessionBar(stand.id, data);
      }
    });
  }

  // Store Firebase refs for resolve button
  window._firebaseRefs = { ref, update, db };
}

// ─── Zone Card Rendering ─────────────────────────────────────
function renderZoneCards() {
  const grid = document.getElementById('zone-grid');
  grid.innerHTML = '';

  for (const zone of ZONES) {
    const card = document.createElement('div');
    card.className = 'zone-card';
    card.id = `zone-${zone.id}`;
    card.dataset.risk = 'low';

    card.innerHTML = `
      <div class="zone-card-header">
        <div>
          <div class="zone-name">${zone.icon} ${zone.name}</div>
          <div class="zone-id">${zone.id}</div>
        </div>
        <span class="risk-badge risk-low" id="risk-${zone.id}">LOW</span>
      </div>
      <div class="zone-metrics">
        <div class="zone-metric">
          <span class="metric-label">Density</span>
          <span class="metric-value density-value" id="density-${zone.id}">
            --<span class="metric-unit">%</span>
          </span>
        </div>
        <div class="zone-metric">
          <span class="metric-label">Queue</span>
          <span class="metric-value queue-value" id="queue-${zone.id}">--</span>
        </div>
      </div>
      <div class="density-bar-track">
        <div class="density-bar-fill risk-low" id="bar-${zone.id}" style="width: 0%"></div>
      </div>
      <div class="zone-prediction" id="pred-${zone.id}">
        <span>10m forecast:</span>
        <span class="pred-value">—</span>
      </div>
      <div class="zone-action" id="action-${zone.id}">Awaiting prediction...</div>
    `;

    grid.appendChild(card);
  }
}

function getRiskLevel(density) {
  if (density >= 90) return 'critical';
  if (density >= 75) return 'high';
  if (density >= 60) return 'medium';
  return 'low';
}

function updateZoneCard(zoneId, data) {
  const card = document.getElementById(`zone-${zoneId}`);
  if (!card) return;

  const density = Math.round(data.density);
  const risk = getRiskLevel(density);

  // Update data attribute
  card.dataset.risk = risk;

  // Update density without full innerHTML repaint
  const densityEl = document.getElementById(`density-${zoneId}`);
  if (
    densityEl.firstChild &&
    densityEl.firstChild.nodeType === Node.TEXT_NODE
  ) {
    densityEl.firstChild.nodeValue = density;
  } else {
    densityEl.innerHTML = `${density}<span class="metric-unit">%</span>`;
  }

  // Update queue
  const queueEl = document.getElementById(`queue-${zoneId}`);
  queueEl.textContent = data.queue_length.toLocaleString();

  // Update risk badge
  const badgeEl = document.getElementById(`risk-${zoneId}`);
  badgeEl.className = `risk-badge risk-${risk}`;
  badgeEl.textContent = risk.toUpperCase();

  // Update density bar
  const barEl = document.getElementById(`bar-${zoneId}`);
  barEl.style.width = `${Math.min(100, density)}%`;
  barEl.className = `density-bar-fill risk-${risk}`;

  // Update timestamp
  const tsEl = document.getElementById('zone-timestamp');
  if (data.timestamp) {
    const time = new Date(data.timestamp);
    tsEl.textContent = `Last update: ${time.toLocaleTimeString()}`;
  }
}

function updateZonePrediction(zoneId, pred) {
  const predEl = document.getElementById(`pred-${zoneId}`);
  if (predEl && pred.density !== undefined) {
    const risk = pred.risk || getRiskLevel(pred.density);
    predEl.innerHTML = `
      <span>10m forecast:</span>
      <span class="pred-value">${Math.round(pred.density)}%</span>
      <span class="risk-badge risk-${risk}" style="font-size:0.55rem;padding:1px 5px;">${risk}</span>
    `;
  }

  const actionEl = document.getElementById(`action-${zoneId}`);
  if (actionEl && pred.action) {
    actionEl.textContent = pred.action;
  }
}

// ─── Concession Bar Rendering ─────────────────────────────────
function renderConcessionBars() {
  const container = document.getElementById('concession-bars');
  container.innerHTML = '';

  for (const stand of CONCESSION_STANDS) {
    const item = document.createElement('div');
    item.className = 'concession-item';
    item.id = `concession-${stand.id}`;

    item.innerHTML = `
      <div class="concession-header">
        <span class="concession-name">🍽️ ${stand.name}</span>
        <div class="concession-stats">
          <span class="concession-stat" id="conc-wait-${stand.id}">
            Wait: <strong>—</strong>
          </span>
          <span class="concession-stat" id="conc-lanes-${stand.id}">
            Lanes: <strong>—</strong>
          </span>
          <span class="surge-badge" id="conc-surge-${stand.id}" style="display:none">
            SURGE
          </span>
        </div>
      </div>
      <div class="concession-bar-track">
        <div class="concession-bar-fill" id="conc-bar-${stand.id}" style="width: 0%"></div>
      </div>
    `;

    container.appendChild(item);
  }
}

function updateConcessionBar(standId, data) {
  const barEl = document.getElementById(`conc-bar-${standId}`);
  if (barEl) {
    barEl.style.width = `${data.load_percent}%`;
    barEl.className = 'concession-bar-fill';
    if (data.load_percent >= 85) barEl.classList.add('load-critical');
    else if (data.load_percent >= 65) barEl.classList.add('load-high');
  }

  const waitEl = document.getElementById(`conc-wait-${standId}`);
  if (waitEl) {
    waitEl.innerHTML = `Wait: <strong>${data.wait_minutes}m</strong>`;
  }

  const lanesEl = document.getElementById(`conc-lanes-${standId}`);
  if (lanesEl) {
    lanesEl.innerHTML = `Lanes: <strong>${data.lanes_open}</strong>`;
  }

  const surgeEl = document.getElementById(`conc-surge-${standId}`);
  if (surgeEl) {
    surgeEl.style.display = data.predicted_surge ? 'inline-block' : 'none';
  }
}

// ─── Alert Feed ───────────────────────────────────────────────
function addAlertCard(alert) {
  const feed = document.getElementById('alert-feed');

  // Remove empty state if present
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  // Check for duplicate
  if (document.getElementById(`alert-${alert.id}`)) return;

  alertCount++;
  updateAlertCount();

  const card = document.createElement('div');
  card.className = 'alert-card';
  card.id = `alert-${alert.id}`;

  const severityIcon = alert.severity === 'critical' ? '🔴' : '🟠';
  const iconClass =
    alert.severity === 'critical' ? 'severity-critical' : 'severity-high';

  const time = new Date(alert.timestamp);
  const timeStr = time.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  card.innerHTML = `
    <div class="alert-severity-icon ${iconClass}">${severityIcon}</div>
    <div class="alert-content">
      <div class="alert-header">
        <span class="alert-zone-name">${alert.zone_name || alert.zone}</span>
        <span class="alert-time">${timeStr}</span>
      </div>
      <div class="alert-message">${alert.message}</div>
      <div class="alert-footer">
        <span class="alert-type-badge">${alert.type || 'crowd'}</span>
        <button class="btn-resolve" onclick="resolveAlert('${alert.id}')" id="resolve-btn-${alert.id}">
          ✓ Resolve
        </button>
      </div>
    </div>
  `;

  // Insert at top
  feed.insertBefore(card, feed.firstChild);
}

function removeAlertCard(alertId) {
  const card = document.getElementById(`alert-${alertId}`);
  if (card) {
    card.classList.add('alert-resolving');
    setTimeout(() => {
      card.remove();
      alertCount = Math.max(0, alertCount - 1);
      updateAlertCount();

      // Show empty state if no alerts
      const feed = document.getElementById('alert-feed');
      if (feed.children.length === 0) {
        feed.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">✅</span>
            <p>All clear — no active alerts</p>
          </div>
        `;
      }
    }, 400);
  }
}

function updateAlertCount() {
  const badge = document.getElementById('alert-count-badge');
  const statAlerts = document.getElementById('stat-alerts');

  badge.textContent = alertCount;
  badge.className = alertCount === 0 ? 'count-badge count-zero' : 'count-badge';

  statAlerts.textContent = alertCount;
}

// Global resolve function (called from onclick)
window.resolveAlert = async function (alertId) {
  // Disable button
  const btn = document.getElementById(`resolve-btn-${alertId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Resolving...';
  }

  if (usingMockData) {
    // Mock mode: just remove the card
    removeAlertCard(alertId);
    return;
  }

  // Firebase mode: write resolved:true
  try {
    const { ref, update } = window._firebaseRefs || {};
    if (ref && update && db) {
      const alertRef = ref(db, `alerts/${alertId}`);
      await update(alertRef, {
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: 'ops_dashboard',
      });
    }
  } catch (err) {
    console.error('Failed to resolve alert:', err);
    // Fall back to just removing the card
    removeAlertCard(alertId);
  }
};

// ─── Connection Status ────────────────────────────────────────
function setConnectionStatus(status, text) {
  const badge = document.getElementById('connection-status');
  badge.className = `status-badge status-${status}`;
  badge.querySelector('.status-text').textContent = text;
}

// ─── Clock ────────────────────────────────────────────────────
function startClock() {
  const clockEl = document.getElementById('clock');
  const update = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };
  update();
  setInterval(update, 1000);
}

// ═══════════════════════════════════════════════════════════════
// ═══ EMERGENCY MOCK DATA FALLBACK ═══
// This is ALWAYS built — it's the safety net for the live demo.
// If Firebase fails, the dashboard stays alive with realistic data.
// ═══════════════════════════════════════════════════════════════

function startMockDataMode() {
  usingMockData = true;
  window._usingMockData = true;
  console.log('[Dashboard] Mock data mode active — cycling every 5s');

  const eventEl = document.getElementById('event-context');
  eventEl.querySelector('.event-text').textContent = 'Demo Mode — Mock Data';

  // Initial data push
  pushMockData();

  // Cycle mock data every 5 seconds
  mockCycleInterval = setInterval(pushMockData, 5000);

  // Add some mock alerts after a delay
  setTimeout(() => {
    addMockAlerts();
  }, 2000);
}

let mockTick = 0;

function pushMockData() {
  mockTick++;

  // Simulate a match in progress — density rises, events trigger
  const elapsedMin = mockTick * 2; // Each tick = 2 simulated minutes
  const isHalftime = elapsedMin >= 42 && elapsedMin <= 55;
  const isFullTime = elapsedMin >= 88;

  // Update event context
  const eventEl = document.getElementById('event-context');
  if (isHalftime) {
    eventEl.querySelector('.event-text').textContent =
      '⚠ Halftime — Surge Active';
  } else if (isFullTime) {
    eventEl.querySelector('.event-text').textContent =
      '🏁 Full Time — Exit Flow';
  } else if (elapsedMin < 42) {
    const minsToHalf = 45 - elapsedMin;
    if (minsToHalf <= 10 && minsToHalf > 0) {
      eventEl.querySelector('.event-text').textContent =
        `Halftime in ${minsToHalf} min`;
    } else {
      eventEl.querySelector('.event-text').textContent =
        `Match: ${elapsedMin}' — 1st Half`;
    }
  } else {
    eventEl.querySelector('.event-text').textContent =
      `Match: ${elapsedMin}' — 2nd Half`;
  }

  const now = new Date().toISOString();

  // Zone densities — each zone has different behavior
  const zoneDensities = {
    gate_north: clamp(
      35 + Math.sin(mockTick * 0.3) * 12 + (isHalftime ? 25 : 0) + rand(-5, 5)
    ),
    gate_south: clamp(
      30 + Math.sin(mockTick * 0.25) * 10 + (isFullTime ? 40 : 0) + rand(-5, 5)
    ),
    gate_east: clamp(25 + Math.sin(mockTick * 0.2) * 8 + rand(-5, 5)),
    gate_west: clamp(
      20 + Math.sin(mockTick * 0.22) * 8 + (isFullTime ? 30 : 0) + rand(-5, 5)
    ),
    concourse_a: clamp(
      40 + Math.sin(mockTick * 0.35) * 15 + (isHalftime ? 45 : 0) + rand(-5, 5)
    ),
    concourse_b: clamp(
      38 + Math.sin(mockTick * 0.28) * 14 + (isHalftime ? 42 : 0) + rand(-5, 5)
    ),
    main_stand: clamp(55 + Math.sin(mockTick * 0.15) * 10 + rand(-3, 3)),
    exit_south: clamp(
      10 + Math.sin(mockTick * 0.18) * 8 + (isFullTime ? 55 : 0) + rand(-5, 5)
    ),
  };

  for (const zone of ZONES) {
    const density = Math.round(zoneDensities[zone.id]);
    const risk = getRiskLevel(density);
    const queueMult =
      density > 85 ? 0.2 : density > 70 ? 0.1 : density > 50 ? 0.04 : 0.015;
    const queue = Math.round(zone.capacity * queueMult + rand(-20, 20));

    updateZoneCard(zone.id, {
      density,
      queue_length: Math.max(0, queue),
      timestamp: now,
    });

    // Mock prediction (slightly above current density)
    const predDensity = clamp(density + rand(2, 12));
    const predRisk = getRiskLevel(predDensity);
    updateZonePrediction(zone.id, {
      density: predDensity,
      risk: predRisk,
      action: getActionForRisk(predRisk, zone.name),
    });
  }

  // Concession data
  const concessionData = {
    stand_a: {
      load: clamp(30 + rand(-10, 20) + (isHalftime ? 45 : 0)),
      lanes: 4,
    },
    stand_b: {
      load: clamp(25 + rand(-10, 15) + (isHalftime ? 50 : 0)),
      lanes: 3,
    },
    stand_c: {
      load: clamp(35 + rand(-10, 18) + (isHalftime ? 40 : 0)),
      lanes: 4,
    },
    stand_d: {
      load: clamp(20 + rand(-10, 12) + (isHalftime ? 35 : 0)),
      lanes: 3,
    },
    express: {
      load: clamp(15 + rand(-5, 20) + (isHalftime ? 30 : 0)),
      lanes: 2,
    },
  };

  for (const stand of CONCESSION_STANDS) {
    const cd = concessionData[stand.id];
    const lanesOpen = Math.max(1, Math.round(cd.lanes * (cd.load / 100)));
    updateConcessionBar(stand.id, {
      load_percent: Math.round(cd.load),
      wait_minutes: Math.round((cd.load / 100) * 18 + rand(-2, 2)),
      lanes_open: Math.min(cd.lanes, lanesOpen + 1),
      predicted_surge: isHalftime || (elapsedMin > 35 && elapsedMin < 45),
    });
  }
}

function addMockAlerts() {
  const mockAlerts = [
    {
      id: 'mock-1',
      zone: 'concourse_a',
      zone_name: 'Concourse A',
      type: 'crowd',
      severity: 'high',
      message:
        'Predicted density 82% in 10 minutes. Open additional concession lanes. Activate redirect signage at Gate 7.',
      timestamp: new Date(Date.now() - 420000).toISOString(),
      resolved: false,
    },
    {
      id: 'mock-2',
      zone: 'gate_north',
      zone_name: 'Gate North',
      type: 'crowd',
      severity: 'critical',
      message:
        'Critical congestion forecast. Divert incoming traffic to Gate East. Deploy 4 additional stewards.',
      timestamp: new Date(Date.now() - 180000).toISOString(),
      resolved: false,
    },
    {
      id: 'mock-3',
      zone: 'concourse_b',
      zone_name: 'Concourse B',
      type: 'concessions',
      severity: 'high',
      message:
        'Halftime surge imminent. Pre-emptively open all lanes at Stand B and Stand C.',
      timestamp: new Date(Date.now() - 60000).toISOString(),
      resolved: false,
    },
  ];

  mockAlerts.forEach((alert, i) => {
    setTimeout(() => addAlertCard(alert), i * 800);
  });
}

function getActionForRisk(risk, zoneName) {
  switch (risk) {
    case 'critical':
      return `Critical: Deploy emergency staff to ${zoneName}. Activate all overflow protocols.`;
    case 'high':
      return `Open additional lanes near ${zoneName}. Redirect crowd flow via alternate routes.`;
    case 'medium':
      return `Monitor ${zoneName} closely. Prepare contingency staff for deployment.`;
    default:
      return `${zoneName} operating within normal parameters.`;
  }
}

// ─── Utility ──────────────────────────────────────────────────
function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, val));
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

// ─── Launch ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
