#!/usr/bin/env python3
"""
NexGate Sensor Simulator
========================
Emits realistic crowd density + queue data to Firebase every 15 seconds.
Supports event surges (kickoff, halftime, full time) and configurable speed.

Fallback mode: If Firebase credentials are missing, outputs JSON to stdout.

Usage:
    python simulator.py                      # Real-time monitoring
    SIMULATION_SPEED=60 python simulator.py  # High-frequency operational mode
"""

import json
import os
import sys
import time
import random
import math
from datetime import datetime, timezone

# Load .env consistently for SIMULATION_SPEED and EVENT_TYPE
try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass  # python-dotenv not installed — fall back to system env vars

# ─── Configuration ───────────────────────────────────────────────
SIMULATION_SPEED = int(os.getenv('SIMULATION_SPEED', '1'))
EVENT_TYPE = os.getenv('EVENT_TYPE', 'football_match')
TICK_INTERVAL = 15  # seconds (real-time)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ─── Load zone & event configs ───────────────────────────────────
with open(os.path.join(BASE_DIR, 'zones_config.json'), 'r') as f:
    zones_config = json.load(f)['zones']

with open(os.path.join(BASE_DIR, 'event_schedule.json'), 'r') as f:
    event_schedule = json.load(f)['events']

# ─── Concession stands ──────────────────────────────────────────
CONCESSION_STANDS = [
    {"id": "stand_a", "name": "Stand A", "base_load": 30, "lanes_total": 4},
    {"id": "stand_b", "name": "Stand B", "base_load": 25, "lanes_total": 3},
    {"id": "stand_c", "name": "Stand C", "base_load": 35, "lanes_total": 4},
    {"id": "stand_d", "name": "Stand D", "base_load": 20, "lanes_total": 3},
    {"id": "express",  "name": "Express Kiosk", "base_load": 15, "lanes_total": 2},
]

# ─── Firebase initialization ────────────────────────────────────
firebase_db = None

def init_firebase():
    """Attempt to initialize Firebase Admin SDK. Returns None if creds missing."""
    global firebase_db
    try:
        import firebase_admin
        from firebase_admin import credentials, db

        cred_path = os.getenv('FIREBASE_SERVICE_ACCOUNT_PATH',
                              os.path.join(BASE_DIR, '..', 'serviceAccountKey.json'))
        db_url = os.getenv('FIREBASE_DATABASE_URL', '')

        if not db_url:
            print("[WARN] FIREBASE_DATABASE_URL not set — running in stdout fallback mode")
            return None

        if not os.path.exists(cred_path):
            print(f"[WARN] Service account key not found at {cred_path} — running in stdout fallback mode")
            return None

        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred, {'databaseURL': db_url})
        firebase_db = db
        print(f"[OK] Firebase connected: {db_url}")
        return firebase_db

    except Exception as e:
        print(f"[WARN] Firebase init failed: {e} — running in stdout fallback mode")
        return None


def get_active_event(elapsed_minutes):
    """Find the current or most recently triggered event based on elapsed time."""
    active = None
    for event in event_schedule:
        offset = event['time_offset_min']
        # Event is active for a 10-minute window after its trigger
        if offset <= elapsed_minutes <= offset + 10:
            if active is None or event['surge_multiplier'] > active['surge_multiplier']:
                active = event
    return active


def calculate_zone_density(zone, elapsed_minutes, active_event):
    """
    Calculate current density for a zone.
    Uses base_load + sinusoidal variation + random noise + event surge.
    """
    base = zone['base_load']

    # Sinusoidal variation: crowd ebbs and flows naturally (±8%)
    time_factor = math.sin(elapsed_minutes * 0.1) * 8

    # Random noise: ±5%
    noise = random.uniform(-5, 5)

    density = base + time_factor + noise

    # Event surge: if this zone is in the surge list, multiply
    if active_event and zone['id'] in active_event['surge_zones']:
        # Surge ramps up over 3 minutes, then holds, then fades over 5 minutes
        offset = active_event['time_offset_min']
        time_into_event = elapsed_minutes - offset

        if time_into_event < 3:
            # Ramp up phase
            ramp = time_into_event / 3.0
            surge = (active_event['surge_multiplier'] - 1.0) * ramp
        elif time_into_event < 7:
            # Hold phase
            surge = active_event['surge_multiplier'] - 1.0
        else:
            # Fade phase
            fade = (10 - time_into_event) / 3.0
            surge = (active_event['surge_multiplier'] - 1.0) * max(0, fade)

        density *= (1.0 + surge)

    # Clamp to 0–100
    return max(0, min(100, round(density, 1)))


def calculate_queue_length(density, capacity):
    """Estimate queue length based on density — exponential growth above 70%."""
    if density < 50:
        return random.randint(0, int(capacity * 0.02))
    elif density < 70:
        return random.randint(int(capacity * 0.02), int(capacity * 0.08))
    elif density < 85:
        return random.randint(int(capacity * 0.08), int(capacity * 0.15))
    else:
        return random.randint(int(capacity * 0.15), int(capacity * 0.25))


def calculate_concession_data(stand, elapsed_minutes, active_event):
    """Calculate concession stand load, lanes open, and wait time."""
    base = stand['base_load']

    # Halftime = concession surge
    is_halftime = active_event and 'Halftime' in active_event.get('label', '')
    if is_halftime:
        load = min(100, base * 2.5 + random.uniform(-5, 10))
        lanes_open = stand['lanes_total']
        predicted_surge = True
    else:
        load = base + random.uniform(-10, 15)
        load = max(5, min(95, load))
        lanes_open = max(1, int(stand['lanes_total'] * (load / 100) + 0.5))
        predicted_surge = elapsed_minutes > 35 and elapsed_minutes < 45  # Pre-halftime warning

    # Wait time correlates with load
    wait_minutes = round(load / 100 * 18 + random.uniform(-2, 2), 1)
    wait_minutes = max(0.5, wait_minutes)

    return {
        "load_percent": round(load, 1),
        "lanes_open": lanes_open,
        "wait_minutes": round(wait_minutes, 1),
        "predicted_surge": predicted_surge
    }


def write_to_firebase(zone_data_list, concession_data_list):
    """Write all zone + concession data to Firebase in a single multi-path update."""
    if firebase_db is None:
        return

    try:
        updates = {}
        for zd in zone_data_list:
            updates[f"zones/{zd['zone_id']}/current"] = {
                "density": zd['density'],
                "queue_length": zd['queue_length'],
                "timestamp": zd['timestamp']
            }

        for cd in concession_data_list:
            updates[f"concessions/{cd['stand_id']}"] = {
                "load_percent": cd['load_percent'],
                "lanes_open": cd['lanes_open'],
                "wait_minutes": cd['wait_minutes'],
                "predicted_surge": cd['predicted_surge']
            }

        firebase_db.reference('/').update(updates)

    except Exception as e:
        print(f"[ERROR] Firebase write failed: {e}")


def print_to_stdout(zone_data_list, concession_data_list, active_event, elapsed_minutes):
    """Fallback: Print JSON to stdout for local testing."""
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "elapsed_minutes": round(elapsed_minutes, 1),
        "active_event": active_event['label'] if active_event else None,
        "simulation_speed": SIMULATION_SPEED,
        "zones": {zd['zone_id']: {
            "density": zd['density'],
            "queue_length": zd['queue_length']
        } for zd in zone_data_list},
        "concessions": {cd['stand_id']: {
            "load_percent": cd['load_percent'],
            "lanes_open": cd['lanes_open'],
            "wait_minutes": cd['wait_minutes'],
            "predicted_surge": cd['predicted_surge']
        } for cd in concession_data_list}
    }
    print(json.dumps(output, indent=2))
    print("---")


def run_simulator():
    """Main simulation loop."""
    print("=" * 60)
    print("  NexGate Sensor Simulator")
    print(f"  Speed: {SIMULATION_SPEED}x | Event: {EVENT_TYPE}")
    print(f"  Zones: {len(zones_config)} | Concession stands: {len(CONCESSION_STANDS)}")
    print(f"  Tick interval: {TICK_INTERVAL / SIMULATION_SPEED:.1f}s (real) = {TICK_INTERVAL}s (simulated)")
    print("=" * 60)

    # Initialize Firebase (or fall back to stdout)
    init_firebase()
    use_firebase = firebase_db is not None

    if use_firebase:
        print("[MODE] Firebase — writing to Realtime Database")
    else:
        print("[MODE] Stdout fallback — printing JSON to console")

    print()

    start_time = time.time()
    tick_count = 0

    try:
        while True:
            # Calculate simulated elapsed time
            real_elapsed = time.time() - start_time
            elapsed_minutes = (real_elapsed * SIMULATION_SPEED) / 60.0

            # Check for active event
            active_event = get_active_event(elapsed_minutes)

            if active_event and tick_count % 5 == 0:
                print(f"[EVENT] {active_event['label']} active at "
                      f"t={elapsed_minutes:.1f}min "
                      f"(surge: {active_event['surge_multiplier']}x on "
                      f"{', '.join(active_event['surge_zones'])})")

            # Calculate zone data
            now = datetime.now(timezone.utc).isoformat()
            zone_data_list = []
            for zone in zones_config:
                density = calculate_zone_density(zone, elapsed_minutes, active_event)
                queue = calculate_queue_length(density, zone['capacity'])
                zone_data_list.append({
                    "zone_id": zone['id'],
                    "density": density,
                    "queue_length": queue,
                    "timestamp": now
                })

            # Calculate concession data
            concession_data_list = []
            for stand in CONCESSION_STANDS:
                cdata = calculate_concession_data(stand, elapsed_minutes, active_event)
                cdata['stand_id'] = stand['id']
                concession_data_list.append(cdata)

            # Output
            if use_firebase:
                write_to_firebase(zone_data_list, concession_data_list)
                # Compact log line
                risk_zones = [zd['zone_id'] for zd in zone_data_list if zd['density'] > 75]
                status = f"t={elapsed_minutes:6.1f}min | "
                status += " ".join(
                    f"{zd['zone_id'].split('_')[-1]}:{zd['density']:4.0f}%"
                    for zd in zone_data_list
                )
                if risk_zones:
                    status += f" | [!] HIGH: {', '.join(risk_zones)}"
                print(status)
            else:
                print_to_stdout(zone_data_list, concession_data_list,
                                active_event, elapsed_minutes)

            tick_count += 1
            # Sleep for the adjusted interval
            time.sleep(TICK_INTERVAL / SIMULATION_SPEED)

    except KeyboardInterrupt:
        print("\n[STOP] Simulator stopped by user.")
        sys.exit(0)


if __name__ == '__main__':
    run_simulator()
