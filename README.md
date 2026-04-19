# NexGate

> **Know before the crowd does.**

Real-time crowd intelligence platform for large-scale sporting venues. Predicts congestion 10–15 minutes before it forms using Gemini AI, synced over Firebase.

---

## Quick Start (5 commands)

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/nexgate.git && cd nexgate

# 2. Configure
cp .env.example .env
# Edit .env — fill in GEMINI_API_KEY and Firebase credentials
# Edit dashboard/app.js — fill in the FIREBASE_CONFIG block at the top

# 3. Run simulator
cd simulator
pip install -r requirements.txt
python simulator.py          # Use SIMULATION_SPEED=10 for demo

# 4. Run prediction engine (in a new terminal)
cd engine
npm install
node index.js

# 5. Open dashboard
# Open dashboard/index.html directly in your browser
# Or: npx serve dashboard/
```

> **Note:** The dashboard uses inline Firebase config (no `.env` — it's vanilla JS with no build step). This is intentional for the hackathon. Edit the `FIREBASE_CONFIG` object at the top of `dashboard/app.js`.

> **No Firebase yet?** The dashboard works standalone with mock data — just open `dashboard/index.html`.

---

## Architecture

```
┌───────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Simulator   │────▶│     Firebase     │◀────│  Gemini 1.5     │
│   (Python)    │     │  Realtime DB     │     │  Flash API      │
│               │     │                  │     │                 │
│ Emits zone    │     │ /zones/          │     │ JSON predictions│
│ density +     │     │ /alerts/         │     │ risk + action   │
│ queue data    │     │ /concessions/    │     │                 │
│ every 15s     │     │                  │     │                 │
└───────────────┘     └────────┬─────────┘     └────────▲────────┘
                               │                        │
                               ▼                        │
                    ┌─────────────────────┐    ┌───────────────┐
                    │   Ops Dashboard     │    │  Prediction   │
                    │   (Vanilla JS)      │    │  Engine       │
                    │                     │    │  (Node.js)    │
                    │ Live zone cards     │    │               │
                    │ Alert feed          │    │ Staggered     │
                    │ Concession bars     │    │ 7.5s/zone     │
                    └─────────────────────┘    └───────────────┘
```

See [docs/architecture.md](docs/architecture.md) for detailed data flow.

---

## Project Structure

```
nexgate/
├── simulator/           Python sensor simulator
│   ├── simulator.py
│   ├── zones_config.json
│   ├── event_schedule.json
│   └── requirements.txt
├── engine/              Node.js Gemini prediction engine
│   ├── index.js
│   ├── predictor.js
│   ├── alertManager.js
│   ├── package.json
│   └── prompts/
│       └── system_prompt.txt
├── dashboard/           Vanilla HTML/CSS/JS ops dashboard
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
│       └── venue_map.svg
├── firebase/            Firebase config
├── docs/                Documentation
├── .env.example         Environment variable template
└── .gitignore
```

---

## Demo

Run at 10x speed for a 3-minute demo:

```bash
# Terminal 1
SIMULATION_SPEED=10 python simulator/simulator.py

# Terminal 2
node engine/index.js

# Browser
open dashboard/index.html
```

See [docs/demo_script.md](docs/demo_script.md) for the full 3-minute pitch script.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Simulator | Python 3 + firebase-admin |
| Prediction Engine | Node.js + @google/generative-ai |
| Dashboard | Vanilla HTML/CSS/JS + Firebase CDN |
| Database | Firebase Realtime Database |
| AI Model | Gemini 1.5 Flash (JSON mode) |

---

## License

Built for the Google Developer Hackathon 2025.