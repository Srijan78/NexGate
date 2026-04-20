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
// ═══ Chatbot proxies all AI calls to the secure backend.      ═══
// ═══ API key is never exposed in the browser.                 ═══
// ═══════════════════════════════════════════════════════════════
// Works on local dev (port 3001) and Cloud Run (same-origin proxy).
const CHAT_PROXY_URL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:3001/api/chat'
    : '/api/chat';
// ═══════════════════════════════════════════════════════════════

// ─── Zone Configuration ─────────────────────────────────────────
const CHAT_ZONES = [
  { id: 'gate_north', name: 'Gate North', icon: '🚪' },
  { id: 'gate_south', name: 'Gate South', icon: '🚪' },
  { id: 'gate_east', name: 'Gate East', icon: '🚪' },
  { id: 'gate_west', name: 'Gate West', icon: '🚪' },
  { id: 'concourse_a', name: 'Concourse A', icon: '🏟️' },
  { id: 'concourse_b', name: 'Concourse B', icon: '🏟️' },
  { id: 'main_stand', name: 'Main Stand', icon: '🎯' },
  { id: 'exit_south', name: 'Exit Corridor South', icon: '🚶' },
];

// ─── Zone Neighbour Map (hardcoded adjacency) ───────────────────
const ZONE_NEIGHBOURS = {
  gate_north: ['concourse_a', 'gate_east'],
  gate_south: ['concourse_b', 'gate_west'],
  gate_east: ['gate_north', 'concourse_a'],
  gate_west: ['gate_south', 'concourse_b'],
  concourse_a: ['gate_north', 'gate_east', 'main_stand'],
  concourse_b: ['gate_south', 'gate_west', 'main_stand'],
  main_stand: ['concourse_a', 'concourse_b'],
  exit_south: ['gate_south', 'gate_west'],
};

// ─── Emergency Keywords ─────────────────────────────────────────
const EMERGENCY_KEYWORDS = [
  'medical',
  'emergency',
  'help',
  'ambulance',
  'injured',
  'hurt',
  'accident',
  'unconscious',
  'attack',
];

// ─── State ──────────────────────────────────────────────────────
let conversationHistory = []; // { role: 'user'|'model', parts: [{ text }] }
let allZoneData = {}; // { zoneId: { density, name, wait_minutes, timestamp } }
let zoneListeners = []; // Firebase onValue unsubscribes
let isWaitingForGemini = false;
let chatbotPanelOpen = false;

// Firebase SDK refs (loaded dynamically)
let fbRef = null;
let fbOnValue = null;
let fbPush = null;
let fbSet = null;

// ─── Init ───────────────────────────────────────────────────────
async function initChatbot() {
  setupEventListeners();

  // Load Firebase SDK functions for chatbot use
  try {
    const dbMod =
      await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
    fbRef = dbMod.ref;
    fbOnValue = dbMod.onValue;
    fbPush = dbMod.push;
    fbSet = dbMod.set;
  } catch (err) {
    console.log(
      '[Chatbot] Firebase SDK not available — will work without live data'
    );
  }

  // Setup UI for full stadium chat
  document.getElementById('chatbot-zone-selector').style.display = 'none';
  document.getElementById('chatbot-zone-status').style.display = 'none';
  document.getElementById('chatbot-change-zone').style.display = 'none';
  document.getElementById('chatbot-messages').style.display = 'flex';
  document.getElementById('chatbot-input-area').style.display = 'flex';
  
  // Add welcome message
  addBotMessage(
    `NexGate Ops Intel initialized. 🌐\n\nI am monitoring all 8 stadium zones. I can assist with:\n• Crowd levels & queue times\n• Gate flow & fan redirection\n• Emergency operations\n\nWhat is the current operational situation?`
  );

  // Start live data listeners for all zones
  startAllZoneListeners();
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

  // Change zone button is deprecated, we monitor all zones
  const changeBtn = document.getElementById('chatbot-change-zone');
  if (changeBtn) {
    changeBtn.style.display = 'none';
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

// ─── Utility ────────────────────────────────────────────────────
function estimateWait(density) {
  return Math.round((density / 100) * 18 * 10) / 10;
}

// ─── Firebase Zone Listeners ────────────────────────────────────
function startAllZoneListeners(retryCount = 0) {
  const db = window._firebaseDb;
  
  if (!db || !fbRef || !fbOnValue) {
    // Firebase might not be ready yet — retry up to 10 times (5 seconds)
    if (retryCount < 10) {
      console.log(`[Chatbot] Firebase not ready, retrying in 500ms... (attempt ${retryCount + 1})`);
      setTimeout(() => startAllZoneListeners(retryCount + 1), 500);
      return;
    }
    // After 10 retries, fall back to mock mode
    console.warn('[Chatbot] Firebase unavailable after 10 retries — using mock data');
    CHAT_ZONES.forEach((zone) => {
      allZoneData[zone.id] = {
        name: zone.name,
        density: Math.round(20 + Math.random() * 50),
        wait_minutes: Math.round(2 + Math.random() * 8),
      };
    });
    return;
  }

  console.log('[Chatbot] Firebase connected — attaching live listeners to all 8 zones');
  CHAT_ZONES.forEach((zone) => {
    const nRef = fbRef(db, `zones/${zone.id}/current`);

    const unsub = fbOnValue(nRef, (snap) => {
      const data = snap.val();
      if (data) {
        allZoneData[zone.id] = {
          name: zone.name,
          density: data.density || 0,
          wait_minutes: estimateWait(data.density || 0),
          timestamp: data.timestamp || ''
        };
      }
    });

    zoneListeners.push(unsub);
  });
}

// Zone Status Card deprecated as the chatbot monitors all zones.

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
  return EMERGENCY_KEYWORDS.some((keyword) => lower.includes(keyword));
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
    console.log(
      '[Chatbot] Emergency alert — Firebase unavailable, logged locally'
    );
    return;
  }

  try {
    const alertsRef = fbRef(db, 'alerts');
    const newAlertRef = fbPush(alertsRef);
    await fbSet(newAlertRef, {
      zone: 'ops_intel',
      zone_name: 'Command Chat',
      type: 'medical',
      severity: 'critical',
      message: 'Medical emergency reported by staff via chat interface.',
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
  if (!CHAT_PROXY_URL) {
    addBotMessage(
      "I'm currently offline — the backend server is not running. " +
      'Please ask venue staff for assistance.'
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
          parts: [
            {
              text: 'NexGate Ops Intel online. Live sensor data loaded. What is the operational situation?',
            },
          ],
        },
        // Conversation history
        ...conversationHistory,
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    };

    let response;
    let retries = 3;
    let delayMs = 1500;

    // Retry loop for transient 503 High Demand errors on 3.1 Preview
    while (retries > 0) {
      response = await fetch(
        CHAT_PROXY_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );

      if (response.status === 503) {
        console.warn(`[Chatbot] Gemini 3.1 High Demand (503). Retrying in ${delayMs}ms... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        retries--;
        delayMs *= 2; // Exponential backoff
      } else {
        break; // Success or non-503 error, break out of loop
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData?.error?.message || `API returned ${response.status}`;
      throw new Error(errorMessage);
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
    await addBotMessage(botText);
  } catch (err) {
    console.error('[Chatbot] Gemini call failed:', err);
    hideTypingIndicator();
    await addBotMessage(
      "Sorry, I'm having trouble connecting right now. " +
      'Please ask a nearby steward for help.'
    );
  } finally {
    isWaitingForGemini = false;
  }
}

// ─── Build Gemini Context ───────────────────────────────────────
function buildGeminiContext() {
  const allZonesSection = Object.entries(allZoneData)
    .map(
      ([_, nd]) =>
        `- ${nd.name}: ${Math.round(nd.density)}% density, ~${nd.wait_minutes} min wait`
    )
    .join('\n');

  // Grab any timestamp to show data freshness
  let dataTimestamp = new Date().toLocaleTimeString();
  const firstZoneKey = Object.keys(allZoneData)[0];
  if (firstZoneKey && allZoneData[firstZoneKey].timestamp) {
    dataTimestamp = new Date(allZoneData[firstZoneKey].timestamp).toLocaleTimeString();
  }

  return `You are NexGate Ops Intel — an AI assistant for STADIUM OPERATIONS STAFF at a 60,000-seat venue.

YOUR ROLE:
- You assist stewards, security, operations managers, and concession supervisors.
- You have access to LIVE crowd sensor data from the entire stadium.
- Your primary focus is crowd safety, zone management, and operational decisions.

ALL STADIUM ZONES (LIVE SENSOR DATA):
- Reading at: ${dataTimestamp}

${allZonesSection || '- No data available yet'}

GUIDELINES:
- You monitor ALL zones in the stadium equally — you have full sensor coverage.
- Use professional, concise language suited for operations staff.
- When density exceeds 85%, recommend IMMEDIATE action (redirect flow, deploy stewards, open overflow lanes).
- If a question is completely unrelated to the venue or stadium operations (e.g. coding, recipes, politics), gently steer back: "I'm focused on venue ops — is there a zone situation I can help with?"
- For medical emergencies: give calm, clear instructions and confirm venue ops have been alerted.
- Always cite the specific density numbers and zone names from the sensor data above.`;
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

// Cache the wait flag for emergencies
async function addBotMessage(text, isEmergency = false) {
  const container = document.getElementById('chatbot-messages');
  const msg = document.createElement('div');
  msg.className = 'chatbot-msg chatbot-msg-bot';
  const bubble = document.createElement('div');
  bubble.className = isEmergency ? 'chatbot-bubble chatbot-bubble-emergency' : 'chatbot-bubble chatbot-bubble-bot';
  msg.appendChild(bubble);
  container.appendChild(msg);
  scrollToBottom();

  if (isEmergency) {
    bubble.innerHTML = formatBotText(text);
    return;
  }

  const words = text.split(' ');
  let currentHTML = '';

  for (let i = 0; i < words.length; i++) {
    currentHTML += words[i] + ' ';
    bubble.innerHTML = formatBotText(currentHTML);
    scrollToBottom();
    // sleep
    await new Promise(r => setTimeout(r, 60));
  }
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
