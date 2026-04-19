/**
 * NexGate — Chatbot Module (chatbot.js)
 * ======================================
 * Context-aware Gemini-powered venue assistant.
 * Reads live zone data from Firebase, builds grounded context,
 * and lets attendees ask about crowds, food, and wayfinding.
 *
 * Fully self-contained — only accesses Firebase via globals
 * exposed by app.js (window._firebaseApp, window._firebaseDb).
 */

// ═══════════════════════════════════════════════════════════════
// ═══ PASTE YOUR CHATBOT GEMINI API KEY HERE ═══
// This is a SEPARATE key from the prediction engine.
// Get one free at: https://aistudio.google.com/app/apikey
// ═══════════════════════════════════════════════════════════════
const GEMINI_API_KEY_CHATBOT = 'YOUR_CHATBOT_GEMINI_KEY_HERE';
// ═══════════════════════════════════════════════════════════════

// ─── Zone Configuration ─────────────────────────────────────────
const CHAT_ZONES = [
  { id: 'gate_north',  name: 'Gate North',          icon: '🚪' },
  { id: 'gate_south',  name: 'Gate South',          icon: '🚪' },
  { id: 'gate_east',   name: 'Gate East',           icon: '🚪' },
  { id: 'gate_west',   name: 'Gate West',           icon: '🚪' },
  { id: 'concourse_a', name: 'Concourse A',         icon: '🏟️' },
  { id: 'concourse_b', name: 'Concourse B',         icon: '🏟️' },
  { id: 'main_stand',  name: 'Main Stand',          icon: '🎯' },
  { id: 'exit_south',  name: 'Exit Corridor South', icon: '🚶' },
];

// ─── Zone Neighbour Map (hardcoded adjacency) ───────────────────
const ZONE_NEIGHBOURS = {
  gate_north:  ['concourse_a', 'gate_east'],
  gate_south:  ['concourse_b', 'gate_west'],
  gate_east:   ['gate_north', 'concourse_a'],
  gate_west:   ['gate_south', 'concourse_b'],
  concourse_a: ['gate_north', 'gate_east', 'main_stand'],
  concourse_b: ['gate_south', 'gate_west', 'main_stand'],
  main_stand:  ['concourse_a', 'concourse_b'],
  exit_south:  ['gate_south', 'gate_west'],
};

// ─── Emergency Keywords ─────────────────────────────────────────
const EMERGENCY_KEYWORDS = [
  'medical', 'emergency', 'help', 'ambulance', 'injured',
  'hurt', 'accident', 'unconscious', 'attack',
];

// ─── State ──────────────────────────────────────────────────────
let selectedZoneId = null;
let selectedZoneName = '';
let conversationHistory = [];   // { role: 'user'|'model', parts: [{ text }] }
let currentZoneData = null;     // live density/queue/risk from Firebase
let neighbourData = {};         // { zoneId: { density, queue, name } }
let zoneListener = null;        // Firebase onValue unsubscribe
let neighbourListeners = [];    // Firebase onValue unsubscribes
let isWaitingForGemini = false;
let chatbotPanelOpen = false;

// Firebase SDK refs (loaded dynamically)
let fbRef = null;
let fbOnValue = null;
let fbPush = null;
let fbSet = null;

// ─── Init ───────────────────────────────────────────────────────
async function initChatbot() {
  renderZoneSelector();
  setupEventListeners();

  // Load Firebase SDK functions for chatbot use
  try {
    const dbMod = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'
    );
    fbRef = dbMod.ref;
    fbOnValue = dbMod.onValue;
    fbPush = dbMod.push;
    fbSet = dbMod.set;
  } catch (err) {
    console.log('[Chatbot] Firebase SDK not available — will work without live data');
  }
}

// ─── Event Listeners ────────────────────────────────────────────
function setupEventListeners() {
  // FAB toggle
  const fab = document.getElementById('chatbot-fab');
  if (fab) {
    fab.addEventListener('click', togglePanel);
  }

  // Close button
  const toggle = document.getElementById('chatbot-toggle');
  if (toggle) {
    toggle.addEventListener('click', togglePanel);
  }

  // Change zone
  const changeBtn = document.getElementById('chatbot-change-zone');
  if (changeBtn) {
    changeBtn.addEventListener('click', resetToZoneSelector);
  }

  // Send message
  const sendBtn = document.getElementById('chatbot-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', handleSendMessage);
  }

  // Enter key
  const input = document.getElementById('chatbot-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    });
  }
}

// ─── Panel Toggle ───────────────────────────────────────────────
function togglePanel() {
  const panel = document.getElementById('chatbot-panel');
  const fab = document.getElementById('chatbot-fab');
  chatbotPanelOpen = !chatbotPanelOpen;

  if (chatbotPanelOpen) {
    panel.classList.add('chatbot-panel-open');
    fab.classList.add('chatbot-fab-hidden');
  } else {
    panel.classList.remove('chatbot-panel-open');
    fab.classList.remove('chatbot-fab-hidden');
  }
}

// ─── Zone Selector ──────────────────────────────────────────────
function renderZoneSelector() {
  const selector = document.getElementById('chatbot-zone-selector');
  if (!selector) return;

  selector.innerHTML = `
    <p class="chatbot-selector-label">Select your current zone:</p>
    <div class="chatbot-zone-grid">
      ${CHAT_ZONES.map(z => `
        <button class="chatbot-zone-btn" data-zone-id="${z.id}">
          <span class="chatbot-zone-btn-icon">${z.icon}</span>
          <span class="chatbot-zone-btn-name">${z.name}</span>
        </button>
      `).join('')}
    </div>
  `;

  // Attach click handlers
  selector.querySelectorAll('.chatbot-zone-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const zoneId = btn.dataset.zoneId;
      selectZone(zoneId);
    });
  });
}

// ─── Select Zone ────────────────────────────────────────────────
function selectZone(zoneId) {
  const zone = CHAT_ZONES.find(z => z.id === zoneId);
  if (!zone) return;

  selectedZoneId = zoneId;
  selectedZoneName = zone.name;
  conversationHistory = [];
  neighbourData = {};

  // Hide selector, show chat UI
  document.getElementById('chatbot-zone-selector').style.display = 'none';
  document.getElementById('chatbot-messages').style.display = 'flex';
  document.getElementById('chatbot-input-area').style.display = 'flex';
  document.getElementById('chatbot-zone-status').style.display = 'flex';
  document.getElementById('chatbot-change-zone').style.display = 'inline-flex';

  // Clear messages
  const msgContainer = document.getElementById('chatbot-messages');
  msgContainer.innerHTML = '';

  // Add welcome message
  addBotMessage(`Welcome to **${zone.name}**! 👋\n\nI can help you with:\n• Crowd levels & wait times\n• Finding shorter queues nearby\n• Food & concession info\n• Directions & wayfinding\n\nWhat would you like to know?`);

  // Start live data listeners
  startZoneListener(zoneId);
  startNeighbourListeners(zoneId);
}

// ─── Reset to Zone Selector ─────────────────────────────────────
function resetToZoneSelector() {
  // Detach all listeners
  if (zoneListener) {
    zoneListener();
    zoneListener = null;
  }
  neighbourListeners.forEach(unsub => unsub());
  neighbourListeners = [];

  // Reset state
  selectedZoneId = null;
  selectedZoneName = '';
  conversationHistory = [];
  currentZoneData = null;
  neighbourData = {};

  // Hide chat UI, show selector
  document.getElementById('chatbot-zone-selector').style.display = 'block';
  document.getElementById('chatbot-messages').style.display = 'none';
  document.getElementById('chatbot-input-area').style.display = 'none';
  document.getElementById('chatbot-zone-status').style.display = 'none';
  document.getElementById('chatbot-change-zone').style.display = 'none';

  // Clear messages
  document.getElementById('chatbot-messages').innerHTML = '';

  // Re-render zone buttons
  renderZoneSelector();
}

// ─── Firebase Zone Listener ─────────────────────────────────────
function startZoneListener(zoneId) {
  const db = window._firebaseDb;
  if (!db || !fbRef || !fbOnValue) {
    // Mock mode — use static data
    currentZoneData = {
      density: 42, queue_length: 85, risk: 'low',
      action: 'Operating within normal parameters.',
      wait_minutes: 3.2,
    };
    updateZoneStatusCard();
    return;
  }

  // Listen to current zone data
  const currentRef = fbRef(db, `zones/${zoneId}/current`);
  const predRef = fbRef(db, `zones/${zoneId}/predictions/next_10m`);

  let currentData = {};
  let predData = {};

  const unsub1 = fbOnValue(currentRef, (snap) => {
    const data = snap.val();
    if (data) {
      currentData = data;
      mergeZoneData(currentData, predData);
    }
  });

  const unsub2 = fbOnValue(predRef, (snap) => {
    const data = snap.val();
    if (data) {
      predData = data;
      mergeZoneData(currentData, predData);
    }
  });

  // Store composite unsubscribe
  zoneListener = () => {
    unsub1();
    unsub2();
  };
}

function mergeZoneData(current, pred) {
  currentZoneData = {
    density: current.density || 0,
    queue_length: current.queue_length || 0,
    timestamp: current.timestamp || '',
    risk: pred.risk || getRiskFromDensity(current.density || 0),
    action: pred.action || '',
    wait_minutes: estimateWait(current.density || 0),
  };
  updateZoneStatusCard();
}

function getRiskFromDensity(d) {
  if (d >= 90) return 'critical';
  if (d >= 75) return 'high';
  if (d >= 60) return 'medium';
  return 'low';
}

function estimateWait(density) {
  return Math.round((density / 100) * 18 * 10) / 10;
}

// ─── Neighbour Listeners ────────────────────────────────────────
function startNeighbourListeners(zoneId) {
  const db = window._firebaseDb;
  const neighbours = ZONE_NEIGHBOURS[zoneId] || [];

  if (!db || !fbRef || !fbOnValue) {
    // Mock mode — populate with dummy data
    neighbours.forEach(nId => {
      const zone = CHAT_ZONES.find(z => z.id === nId);
      neighbourData[nId] = {
        name: zone ? zone.name : nId,
        density: Math.round(20 + Math.random() * 50),
        wait_minutes: Math.round(2 + Math.random() * 8),
      };
    });
    return;
  }

  neighbours.forEach(nId => {
    const nRef = fbRef(db, `zones/${nId}/current`);
    const zone = CHAT_ZONES.find(z => z.id === nId);

    const unsub = fbOnValue(nRef, (snap) => {
      const data = snap.val();
      if (data) {
        neighbourData[nId] = {
          name: zone ? zone.name : nId,
          density: data.density || 0,
          wait_minutes: estimateWait(data.density || 0),
        };
      }
    });

    neighbourListeners.push(unsub);
  });
}

// ─── Zone Status Card ───────────────────────────────────────────
function updateZoneStatusCard() {
  const card = document.getElementById('chatbot-zone-status');
  if (!card || !currentZoneData) return;

  const risk = currentZoneData.risk || 'low';

  card.innerHTML = `
    <div class="chatbot-status-row">
      <span class="chatbot-status-zone-name">${selectedZoneName}</span>
      <span class="risk-badge risk-${risk}">${risk.toUpperCase()}</span>
    </div>
    <div class="chatbot-status-metrics">
      <div class="chatbot-status-metric">
        <span class="chatbot-status-label">Density</span>
        <span class="chatbot-status-value">${Math.round(currentZoneData.density)}%</span>
      </div>
      <div class="chatbot-status-metric">
        <span class="chatbot-status-label">Queue</span>
        <span class="chatbot-status-value">${currentZoneData.queue_length}</span>
      </div>
      <div class="chatbot-status-metric">
        <span class="chatbot-status-label">Wait</span>
        <span class="chatbot-status-value">${currentZoneData.wait_minutes}m</span>
      </div>
    </div>
  `;
}

// ─── Message Handling ───────────────────────────────────────────
async function handleSendMessage() {
  const input = document.getElementById('chatbot-input');
  const text = input.value.trim();
  if (!text || isWaitingForGemini) return;

  input.value = '';
  addUserMessage(text);

  // Check for emergency keywords
  const isEmergency = checkEmergency(text);

  if (isEmergency) {
    await handleEmergency(text);
  } else {
    await callGemini(text);
  }
}

// ─── Emergency Detection & Handling ─────────────────────────────
function checkEmergency(text) {
  const lower = text.toLowerCase();
  return EMERGENCY_KEYWORDS.some(keyword => lower.includes(keyword));
}

async function handleEmergency(userText) {
  // 1. Immediately show red emergency card
  addEmergencyMessage(
    '🚨 **Emergency detected.** Your alert has been sent to venue operations immediately.\n\n' +
    'Stay calm. Help is being dispatched to your zone.'
  );

  // 2. Write alert to Firebase
  await writeEmergencyAlert();

  // 3. Also ask Gemini for calm instructions
  await callGemini(userText, true);
}

async function writeEmergencyAlert() {
  const db = window._firebaseDb;
  if (!db || !fbRef || !fbPush || !fbSet) {
    console.log('[Chatbot] Emergency alert — Firebase unavailable, logged locally');
    return;
  }

  try {
    const alertsRef = fbRef(db, 'alerts');
    const newAlertRef = fbPush(alertsRef);
    await fbSet(newAlertRef, {
      zone: selectedZoneId,
      zone_name: selectedZoneName,
      type: 'medical',
      severity: 'critical',
      message: 'Medical emergency reported by attendee via chat',
      timestamp: new Date().toISOString(),
      resolved: false,
    });
    console.log('[Chatbot] Emergency alert written to Firebase');
  } catch (err) {
    console.error('[Chatbot] Failed to write emergency alert:', err);
  }
}

// ─── Gemini API Call ────────────────────────────────────────────
async function callGemini(userText, isFollowUp = false) {
  if (!GEMINI_API_KEY_CHATBOT || GEMINI_API_KEY_CHATBOT === 'YOUR_CHATBOT_GEMINI_KEY_HERE') {
    addBotMessage(
      "I'm currently offline — my API key hasn't been configured yet. " +
      "Please ask venue staff for assistance."
    );
    return;
  }

  isWaitingForGemini = true;
  showTypingIndicator();

  try {
    // Build context from live data
    const context = buildGeminiContext();

    // Add user message to history
    conversationHistory.push({
      role: 'user',
      parts: [{ text: userText }],
    });

    // Trim history to last 10 messages
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(-10);
    }

    // Build request payload
    const payload = {
      contents: [
        // System-level context as first "user" turn
        {
          role: 'user',
          parts: [{ text: context }],
        },
        {
          role: 'model',
          parts: [{ text: 'Understood. I have the live venue data. How can I help you?' }],
        },
        // Conversation history
        ...conversationHistory,
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 150,
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY_CHATBOT}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const botText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I couldn't process that. Please try again.";

    // Add bot response to history
    conversationHistory.push({
      role: 'model',
      parts: [{ text: botText }],
    });

    hideTypingIndicator();
    addBotMessage(botText);

  } catch (err) {
    console.error('[Chatbot] Gemini call failed:', err);
    hideTypingIndicator();
    addBotMessage(
      "Sorry, I'm having trouble connecting right now. " +
      "Please ask a nearby steward for help."
    );
  } finally {
    isWaitingForGemini = false;
  }
}

// ─── Build Gemini Context ───────────────────────────────────────
function buildGeminiContext() {
  const zd = currentZoneData || {
    density: 0, queue_length: 0, wait_minutes: 0, risk: 'low', action: '',
  };

  // Filter neighbours: density < 80%, sort ascending, max 2
  const filteredNeighbours = Object.entries(neighbourData)
    .filter(([_, nd]) => nd.density < 80)
    .sort((a, b) => a[1].density - b[1].density)
    .slice(0, 2);

  let neighbourSection = '';
  if (filteredNeighbours.length > 0) {
    neighbourSection = filteredNeighbours
      .map(([_, nd]) => `- ${nd.name}: ${Math.round(nd.density)}% full, ${nd.wait_minutes} min wait`)
      .join('\n');
  } else {
    neighbourSection = '- ALL nearby zones are above 80% capacity (stadium-wide surge)';
  }

  return `You are NexGate's venue assistant helping an attendee inside a 60,000 seat stadium.

ATTENDEE LOCATION: ${selectedZoneName}
Current density: ${Math.round(zd.density)}%
Queue length: ${zd.queue_length} people
Wait time: ${zd.wait_minutes} min
Risk level: ${zd.risk}
Recommended action: ${zd.action}

NEARBY ZONES ONLY (realistic walking distance):
${neighbourSection}

RULES:
- Only suggest the nearby zones listed above
- Never suggest zones not in the nearby list
- If all nearby zones are above 80% density say: 'All nearby zones are at high capacity right now, this is a stadium-wide surge — best to wait 5-7 minutes for it to ease'
- For medical emergencies: give calm instructions AND reassure that venue ops have been alerted
- Keep answers short, direct, friendly
- You know the venue layout — speak with confidence`;
}

// ─── DOM: Add Messages ──────────────────────────────────────────
function addUserMessage(text) {
  const container = document.getElementById('chatbot-messages');
  const msg = document.createElement('div');
  msg.className = 'chatbot-msg chatbot-msg-user';
  msg.innerHTML = `<div class="chatbot-bubble chatbot-bubble-user">${escapeHtml(text)}</div>`;
  container.appendChild(msg);
  scrollToBottom();
}

function addBotMessage(text) {
  const container = document.getElementById('chatbot-messages');
  const msg = document.createElement('div');
  msg.className = 'chatbot-msg chatbot-msg-bot';
  msg.innerHTML = `<div class="chatbot-bubble chatbot-bubble-bot">${formatBotText(text)}</div>`;
  container.appendChild(msg);
  scrollToBottom();
}

function addEmergencyMessage(text) {
  const container = document.getElementById('chatbot-messages');
  const msg = document.createElement('div');
  msg.className = 'chatbot-msg chatbot-msg-bot';
  msg.innerHTML = `<div class="chatbot-bubble chatbot-bubble-emergency">${formatBotText(text)}</div>`;
  container.appendChild(msg);
  scrollToBottom();
}

// ─── Typing Indicator ───────────────────────────────────────────
function showTypingIndicator() {
  const container = document.getElementById('chatbot-messages');
  // Remove any existing indicator
  hideTypingIndicator();

  const indicator = document.createElement('div');
  indicator.className = 'chatbot-msg chatbot-msg-bot';
  indicator.id = 'chatbot-typing-indicator';
  indicator.innerHTML = `
    <div class="chatbot-bubble chatbot-bubble-bot chatbot-typing">
      <span class="chatbot-typing-dot"></span>
      <span class="chatbot-typing-dot"></span>
      <span class="chatbot-typing-dot"></span>
    </div>
  `;
  container.appendChild(indicator);
  scrollToBottom();
}

function hideTypingIndicator() {
  const indicator = document.getElementById('chatbot-typing-indicator');
  if (indicator) indicator.remove();
}

// ─── Utilities ──────────────────────────────────────────────────
function scrollToBottom() {
  const container = document.getElementById('chatbot-messages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatBotText(text) {
  // Simple markdown-like formatting: **bold**, \n → <br>
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
    .replace(/• /g, '&bull; ');
}

// ─── Launch ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initChatbot);
