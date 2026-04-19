/**
 * NexGate — Alert Manager (alertManager.js)
 * ==========================================
 * Creates and manages alerts in Firebase when Gemini flags
 * high or critical risk zones. Includes deduplication —
 * won't create duplicate alerts for the same zone if
 * an unresolved one already exists.
 */

// ─── In-memory tracking of active (unresolved) alerts per zone ──
const activeAlerts = new Map(); // zoneId → alertId

// ─── Firebase reference (set during init) ───────────────────────
let alertsRef = null;
let db = null;

/**
 * Initialize the alert manager with a Firebase database reference.
 */
export function initAlertManager(firebaseDb) {
  db = firebaseDb;
  alertsRef = db.ref('alerts');

  // Sync existing unresolved alerts into memory on startup
  alertsRef
    .orderByChild('resolved')
    .equalTo(false)
    .once('value', (snapshot) => {
      const alerts = snapshot.val();
      if (alerts) {
        Object.entries(alerts).forEach(([alertId, alert]) => {
          activeAlerts.set(alert.zone, alertId);
        });
        console.log(
          `[AlertManager] Loaded ${activeAlerts.size} active alerts from Firebase`
        );
      }
    });

  // Listen for resolved alerts to clean up tracking
  alertsRef.on('child_changed', (snapshot) => {
    const alert = snapshot.val();
    if (alert && alert.resolved === true) {
      activeAlerts.delete(alert.zone);
      console.log(`[AlertManager] Alert resolved for zone: ${alert.zone}`);
    }
  });

  console.log('[OK] Alert manager initialized');
}

/**
 * Determine the alert type based on zone ID and risk context.
 */
function determineAlertType(zoneId, prediction) {
  if (zoneId.startsWith('gate_') || zoneId.startsWith('exit_')) {
    return 'crowd';
  }
  if (zoneId.startsWith('concourse_')) {
    return prediction.predicted_density_10m > 90 ? 'crowd' : 'concessions';
  }
  if (zoneId === 'main_stand') {
    return 'crowd';
  }
  return 'facilities';
}

/**
 * Process a prediction and create an alert if risk is high or critical.
 * Returns the alert object if one was created, null otherwise.
 */
export async function processAlert(zone, prediction) {
  if (!alertsRef) {
    console.warn('[AlertManager] Not initialized — skipping alert');
    return null;
  }

  const riskLevel = prediction.risk_level;

  // Only alert on high or critical
  if (riskLevel !== 'high' && riskLevel !== 'critical') {
    // If risk has dropped below high, check if we should auto-resolve
    if (activeAlerts.has(zone.id) && riskLevel === 'low') {
      await autoResolveAlert(zone.id);
    }
    return null;
  }

  // Deduplication: don't create a new alert if one already exists for this zone
  if (activeAlerts.has(zone.id)) {
    // Update existing alert's message if severity changed
    const existingAlertId = activeAlerts.get(zone.id);
    try {
      await alertsRef.child(existingAlertId).update({
        severity: riskLevel,
        message: prediction.recommended_action,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `[AlertManager] Failed to update alert for ${zone.id}: ${err.message}`
      );
    }
    return null;
  }

  // Create new alert
  const alert = {
    zone: zone.id,
    zone_name: zone.name,
    type: determineAlertType(zone.id, prediction),
    severity: riskLevel,
    message:
      prediction.recommended_action || `High density alert for ${zone.name}`,
    predicted_density: prediction.predicted_density_10m,
    timestamp: new Date().toISOString(),
    resolved: false,
  };

  try {
    const newRef = await alertsRef.push(alert);
    activeAlerts.set(zone.id, newRef.key);

    console.log(
      `  [ALERT] ${riskLevel.toUpperCase()} — ${zone.name}: ${alert.message}`
    );

    return { id: newRef.key, ...alert };
  } catch (err) {
    console.error(
      `[AlertManager] Failed to create alert for ${zone.id}: ${err.message}`
    );
    return null;
  }
}

/**
 * Auto-resolve an alert when risk drops to low.
 */
async function autoResolveAlert(zoneId) {
  const alertId = activeAlerts.get(zoneId);
  if (!alertId || !alertsRef) return;

  try {
    await alertsRef.child(alertId).update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: 'auto',
    });
    activeAlerts.delete(zoneId);
    console.log(`  [RESOLVED] Auto-resolved alert for zone: ${zoneId}`);
  } catch (err) {
    console.error(
      `[AlertManager] Failed to auto-resolve alert for ${zoneId}: ${err.message}`
    );
  }
}

/**
 * Get count of currently active (unresolved) alerts.
 */
export function getActiveAlertCount() {
  return activeAlerts.size;
}
