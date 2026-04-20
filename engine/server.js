/**
 * NexGate — Secure Chat Proxy Server (server.js)
 * ================================================
 * Exposes POST /api/chat — receives conversation history from the dashboard
 * and forwards it to Gemini using the server-side API key from .env.
 *
 * The Gemini API key is NEVER sent to the browser.
 *
 * CORS Policy:
 *   - Local dev  : allows localhost:3456 (npx serve)
 *   - Cloud Run  : set ALLOWED_ORIGIN env var to your deployed dashboard URL
 *                  e.g. ALLOWED_ORIGIN=https://nexgate-xxxx.a.run.app
 *
 * Port: process.env.PORT (Cloud Run injects this) or 3001 for local dev.
 */

import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? [process.env.ALLOWED_ORIGIN]
  : ['http://localhost:3456', 'http://127.0.0.1:3456'];

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin header (curl, same-origin on Cloud Run)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: Origin '${origin}' is not allowed`));
    },
    methods: ['POST'],
  })
);

app.use(express.json());

// ─── Gemini model (set during initChatServer) ─────────────────────────────────
let model = null;

/**
 * Initialize the Gemini model and start the Express server.
 * @param {string|null} apiKey - Gemini API key from .env. If null, the server
 *   starts but every /api/chat request returns HTTP 503 with a clear message.
 */
export function initChatServer(apiKey) {
  if (apiKey) {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite-preview',
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    });
    console.log('[ChatServer] Gemini model ready (gemini-3.1-flash-lite-preview)');
  } else {
    console.warn(
      '[ChatServer] No API key provided — /api/chat will return 503 until key is set.'
    );
  }

  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`[ChatServer] Secure proxy listening on port ${port}`);
  });
}

// ─── POST /api/chat ───────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  // If the model was not initialized (missing key), return a clean 503
  if (!model) {
    return res.status(503).json({
      error:
        'Chat service unavailable — GEMINI_API_KEY or GEMINI_API_KEY_CHATBOT is not configured on the server.',
    });
  }

  const { contents, generationConfig } = req.body;

  if (!contents || !Array.isArray(contents)) {
    return res.status(400).json({ error: 'Missing or invalid "contents" array in request body.' });
  }

  // ─── Retry loop: exponential backoff for 503 High Demand responses ────────
  let retries = 3;
  let delayMs = 1500;
  let result;

  while (retries > 0) {
    try {
      result = await model.generateContent({
        contents,
        generationConfig: generationConfig || {
          temperature: 0.7,
          maxOutputTokens: 1024,
        },
      });
      break; // Success — exit retry loop
    } catch (err) {
      if (err.message?.includes('503') && retries > 1) {
        console.warn(`[ChatServer] Gemini 503 — retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
        retries--;
        delayMs *= 2; // Exponential backoff
      } else {
        // Non-retryable or final retry — propagate error
        console.error('[ChatServer] Gemini error:', err.message);
        return res.status(500).json({ error: err.message || 'Internal server error' });
      }
    }
  }

  try {
    const text = result.response.text();
    // Return structure matching what chatbot.js expects
    res.json({
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
        },
      ],
    });
  } catch (err) {
    console.error('[ChatServer] Response parsing error:', err.message);
    res.status(500).json({ error: 'Failed to parse Gemini response.' });
  }
});
