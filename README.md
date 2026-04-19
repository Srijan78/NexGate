<div align="center">
  <h1>NexGate</h1>
  <p><strong>AI-Powered Stadium Crowd Analytics & Logistics Monitoring</strong></p>
  
  <p>
    <img src="https://img.shields.io/badge/Google-Gemini_3_Flash-4285F4?style=for-the-badge&logo=google&logoColor=white" />
    <img src="https://img.shields.io/badge/Firebase-Realtime_DB-FFCA28?style=for-the-badge&logo=firebase&logoColor=black" />
    <img src="https://img.shields.io/badge/Node.js-Prediction_Engine-339933?style=for-the-badge&logo=node.js&logoColor=white" />
    <img src="https://img.shields.io/badge/Python-Simulator-3776AB?style=for-the-badge&logo=python&logoColor=white" />
  </p>
</div>

## 📌 Project Overview
NexGate is a comprehensive stadium operations platform designed to enhance attendee safety and optimize venue logistics. By integrating live sensor data with advanced AI forecasting, NexGate allows event staff to identify crowd surges and congestion points before they reach critical levels.

## 🚀 Key Capabilities

*   **⚡ Predictive Risk Analysis:** Utilizes Gemini 3 Flash to analyze real-time density trends and provide 10-minute risk forecasts for every zone in the stadium.
*   **🔄 Real-time Operations Sync:** Powered by Firebase Realtime Database, providing sub-second synchronization between backend sensors and situational awareness dashboards.
*   **🔋 Efficient Resource Management:** Implements an "Active Heartbeat" protocol to dynamically scale backend intensity based on user engagement, optimizing cloud resource consumption.
*   **🍔 Concession Load Balancing:** Real-time monitoring of food and beverage wait times to redirect traffic and minimize attendee queues.
*   **♿ Accessible Operations Dashboard:** Built with inclusive design principles, featuring high-contrast skeuomorphic UI and full screen-reader support via semantic ARIA implementation.

## 🧠 System Architecture

NexGate uses a reactive message-bus architecture to decouple physical sensors from the AI reasoning engine.

```mermaid
graph TD
    classDef python fill:#222,stroke:#3776ab,stroke-width:2px,color:#fff
    classDef node fill:#222,stroke:#339933,stroke-width:2px,color:#fff
    classDef frontend fill:#222,stroke:#e34f26,stroke-width:2px,color:#fff
    classDef google fill:#222,stroke:#4285F4,stroke-width:2px,color:#fff
    classDef data fill:#222,stroke:#EA4335,stroke-width:2px,color:#fff

    subgraph "Sensing & Logic"
        Sim["🐍 Sensor Simulator<br>(Python)"]:::python
        Engine["🟢 Prediction Engine<br>(Node.js)"]:::node
    end
    
    subgraph "User Interface"
        Dash["💻 Ops Command Center<br>(Vanilla JS/CSS)"]:::frontend
        Chat["💬 AI Ops Assistant"]:::frontend
    end

    subgraph "Infrastructure"
        DB[("🔥 Firebase RTDB<br>(Central Sync)")]:::data
        Gemini["✨ Gemini 3 Flash<br>(Heuristic AI)"]:::google
    end

    Sim -- "1. Broadcasts Sensor Data" --> DB
    
    DB -- "2. Syncs Metrics" --> Engine
    Engine -- "3. Requests Analysis" --> Gemini
    Gemini -- "4. Returns 10m Forecast" --> Engine
    Engine -- "5. Writes Updates" --> DB
    
    DB -- "6. Real-time UI Update" --> Dash
    DB -. "Contextual Knowledge" .-> Chat
    
    Chat -- "7. NLP Query" --> Gemini
    Gemini -- "8. Response" --> Chat
```

## 🛠️ Quick Start

**1. Configuration**
Add your Firebase Project ID, Database URL, and Gemini API Key to a `.env` file in the root directory.

**2. Simulation**
Initialize the sensor network simulator:
```bash
cd simulator
python simulator.py
```

**3. AI Analysis**
Boot the prediction engine:
```bash
cd engine
npm install
npm start
```

**4. Dashboard**
Serve the web interface to view the live stadium matrix:
```bash
cd dashboard
npx serve . -l 3456
```
Open `http://localhost:3456` in your browser.