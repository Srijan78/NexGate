# NexGate — System Architecture

## Overview

NexGate uses a three-layer loop: **Sense → Predict → Act**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NexGate System                               │
│                                                                     │
│  ┌─────────────┐                              ┌──────────────────┐ │
│  │  SENSE      │    Firebase Realtime DB       │  PREDICT          │ │
│  │             │                               │                  │ │
│  │ simulator.py│──▶ /zones/{id}/current ──────▶│ predictor.js     │ │
│  │             │    (density, queue, timestamp) │                  │ │
│  │ Every 15s   │                               │ Reads last 5     │ │
│  │ per zone    │                               │ readings, calls  │ │
│  └─────────────┘                               │ Gemini 1.5 Flash │ │
│                                                │                  │ │
│                     /zones/{id}/predictions ◀──│ Writes risk +    │ │
│                     (risk, action, confidence)  │ recommended      │ │
│                                                │ action           │ │
│                     /alerts/{id} ◀─────────────│                  │ │
│                     (if risk ≥ high)            │ alertManager.js  │ │
│                                                └──────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────┐                        │
│  │  ACT                                    │                        │
│  │                                         │                        │
│  │  dashboard/app.js                       │                        │
│  │  - onValue: /zones/* → zone cards       │                        │
│  │  - onChildAdded: /alerts/ → alert feed  │                        │
│  │  - onValue: /concessions/* → load bars  │                        │
│  │                                         │                        │
│  │  Ops team sees real-time state +        │                        │
│  │  Gemini's recommended actions           │                        │
│  └─────────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow (Step by Step)

| Step | Component | Action | Destination |
|------|-----------|--------|-------------|
| 1 | `simulator.py` | Emits zone density + queue data every 15 sec | Firebase `/zones/{id}/current` |
| 2 | `predictor.js` | Reads last 5 readings, builds Gemini prompt | Gemini 1.5 Flash API |
| 3 | Gemini API | Returns JSON: risk level + recommended action | `predictor.js` response handler |
| 4 | `alertManager.js` | If risk ≥ high, writes alert | Firebase `/alerts/{id}` |
| 5 | `dashboard/app.js` | Firebase listener fires, updates DOM in real time | Ops dashboard UI |

## Firebase Realtime Database Schema

```
nexgate-db/
├── zones/
│   └── {zone_id}/                    // gate_north, gate_south, ...
│       ├── current/
│       │   ├── density: number       // 0–100 (% of zone capacity)
│       │   ├── queue_length: number  // people in queue
│       │   └── timestamp: string     // ISO 8601
│       └── predictions/
│           ├── next_10m/
│           │   ├── density: number
│           │   ├── queue: number
│           │   ├── risk: "low"|"medium"|"high"|"critical"
│           │   ├── action: string    // max 120 chars
│           │   └── confidence: number // 0.0–1.0
│           └── next_15m/             // same shape
├── alerts/
│   └── {alert_id}/
│       ├── zone: string
│       ├── zone_name: string
│       ├── type: "crowd"|"medical"|"facilities"|"concessions"
│       ├── severity: "low"|"medium"|"high"|"critical"
│       ├── message: string
│       ├── predicted_density: number
│       ├── timestamp: string
│       └── resolved: boolean
├── concessions/
│   └── {stand_id}/                   // stand_a, stand_b, ...
│       ├── load_percent: number
│       ├── lanes_open: number
│       ├── wait_minutes: number
│       └── predicted_surge: boolean
└── orders/                           // Phase 2 — companion app
    └── {order_id}/
        ├── items: array
        ├── status: "pending"|"ready"|"collected"
        ├── pickup_stand: string
        └── created_at: string
```

## Zone Configuration

| Zone ID | Name | Capacity | Base Load |
|---------|------|----------|-----------|
| `gate_north` | Gate North | 3,000 | 35% |
| `gate_south` | Gate South | 3,000 | 30% |
| `gate_east` | Gate East | 2,000 | 25% |
| `gate_west` | Gate West | 2,000 | 20% |
| `concourse_a` | Concourse A | 5,000 | 40% |
| `concourse_b` | Concourse B | 5,000 | 38% |
| `main_stand` | Main Stand Area | 8,000 | 55% |
| `exit_south` | Exit Corridor South | 4,000 | 10% |

## Prediction Engine Details

- **Model**: Gemini 1.5 Flash
- **Temperature**: 0.2 (low for consistent predictions)
- **Output format**: `responseMimeType: 'application/json'`
- **Processing**: Staggered — one zone every 7.5 seconds to avoid rate limits
- **Fallback**: Per-zone caching + simple moving average when Gemini is down

## Risk Thresholds

| Level | Density Range | Dashboard Color | Action |
|-------|---------------|-----------------|--------|
| Low | < 60% | Green | No action |
| Medium | 60–75% | Amber | Monitor |
| High | 75–90% | Red | Alert fires |
| Critical | > 90% | Red + pulse | Alert fires + emergency |
