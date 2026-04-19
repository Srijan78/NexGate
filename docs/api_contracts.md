# NexGate — API Contracts

## 1. Firebase Realtime Database Paths

### Zones — Current Readings

**Path:** `/zones/{zone_id}/current`  
**Writer:** `simulator.py`  
**Reader:** `predictor.js`, `dashboard/app.js`

```json
{
  "density": 72.5,           // number, 0–100 (% of zone capacity)
  "queue_length": 384,       // number, people in queue at this zone
  "timestamp": "2025-01-15T14:23:45.000Z"  // string, ISO 8601
}
```

**Valid zone IDs:** `gate_north`, `gate_south`, `gate_east`, `gate_west`, `concourse_a`, `concourse_b`, `main_stand`, `exit_south`

---

### Zones — Predictions

**Path:** `/zones/{zone_id}/predictions/next_10m` and `next_15m`  
**Writer:** `predictor.js`  
**Reader:** `dashboard/app.js`

```json
{
  "density": 85.2,           // number, predicted density 0–100
  "queue": 520,              // number, predicted queue length
  "risk": "high",            // string, "low"|"medium"|"high"|"critical"
  "action": "Open 2 additional concession lanes. Activate redirect signage at Gate 7.",
                              // string, max 120 chars, ops-facing
  "confidence": 0.82         // number, 0.0–1.0
}
```

---

### Alerts

**Path:** `/alerts/{alert_id}`  
**Writer:** `alertManager.js`  
**Reader:** `dashboard/app.js`

```json
{
  "zone": "concourse_a",             // string, zone ID
  "zone_name": "Concourse A",       // string, human-readable
  "type": "crowd",                   // string, "crowd"|"medical"|"facilities"|"transport"|"concessions"
  "severity": "high",                // string, "low"|"medium"|"high"|"critical"
  "message": "Open 2 additional concession lanes.",  // string
  "predicted_density": 85.2,         // number
  "timestamp": "2025-01-15T14:23:45.000Z",  // string, ISO 8601
  "resolved": false,                 // boolean
  "resolved_at": null,               // string|null, ISO 8601
  "resolved_by": null                // string|null, "ops_dashboard"|"auto"
}
```

**Alert creation rules:**
- Created when `prediction.risk_level` is `"high"` or `"critical"`
- **Deduplicated:** No new alert if unresolved alert already exists for same zone
- Existing alert is updated (severity, message) if risk level changes
- Auto-resolved when risk drops to `"low"`

---

### Concessions

**Path:** `/concessions/{stand_id}`  
**Writer:** `simulator.py`  
**Reader:** `dashboard/app.js`

```json
{
  "load_percent": 78.3,       // number, 0–100
  "lanes_open": 3,            // number, currently active service lanes
  "wait_minutes": 12.5,       // number, estimated wait time
  "predicted_surge": true      // boolean, surge expected within 10 min
}
```

**Valid stand IDs:** `stand_a`, `stand_b`, `stand_c`, `stand_d`, `express`

---

## 2. Gemini API Contract

### System Prompt

Located at: `engine/prompts/system_prompt.txt`

Instructs Gemini to respond with **valid JSON only** — no prose, no markdown fences.

### User Prompt Template

```
Zone: {zone.name}
Capacity: {zone.capacity} people
Event context: {eventContext}

Last {N} sensor readings (oldest to newest):
- {timestamp}: density={density}%, queue={queue_length} people
- ...

Predict crowd conditions at this zone for the next 10 and 15 minutes.
Recommend one specific action for the operations team.
```

### Expected Response Schema

```json
{
  "predicted_density_10m": 85,     // number, 0–100
  "predicted_density_15m": 72,     // number, 0–100
  "predicted_queue_10m": 520,      // number, people count
  "risk_level": "high",            // string, "low"|"medium"|"high"|"critical"
  "recommended_action": "Open 2 additional concession lanes.",  // string, max 120 chars
  "confidence": 0.82               // number, 0.0–1.0
}
```

### Gemini Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Model | `gemini-1.5-flash` | Fast, cost-effective |
| `responseMimeType` | `application/json` | Enforces JSON output |
| `temperature` | `0.2` | Low = consistent predictions |
| `maxOutputTokens` | `256` | Response is small JSON |

### Risk Level Thresholds

| Risk Level | Density Range |
|------------|---------------|
| `low` | < 60% |
| `medium` | 60–75% |
| `high` | 75–90% |
| `critical` | > 90% |

### Error Handling

1. **JSON parse failure:** Fall back to simple moving average of last 5 readings
2. **API timeout:** Serve cached last-successful prediction for that zone
3. **Rate limit:** Staggered processing (7.5s between zones) prevents this under normal load
