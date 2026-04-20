import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json());

let model = null;

export function initChatServer(apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({
    model: 'gemini-3.1-flash-lite-preview',
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  const port = process.env.PORT || 3001;
  app.listen(port, () => {
    console.log(`[ChatServer] Secure proxy listening on port ${port}`);
  });
}

app.post('/api/chat', async (req, res) => {
  if (!model) {
    return res.status(500).json({ error: 'Chat server not initialized with API key' });
  }

  const { contents, generationConfig } = req.body;

  if (!contents) {
    return res.status(400).json({ error: 'Missing contents in request body' });
  }

  try {
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
          }
        });
        break; 
      } catch (err) {
        if (err.message?.includes('503') && retries > 1) {
          console.warn(`[ChatServer] Gemini 503 error. Retrying in ${delayMs}ms...`);
          await new Promise(r => setTimeout(r, delayMs));
          retries--;
          delayMs *= 2;
        } else {
          throw err;
        }
      }
    }

    const response = await result.response;
    const text = response.text();

    // Reconstruct the response structure the frontend expects
    res.json({
      candidates: [
        {
          content: {
            parts: [{ text }]
          }
        }
      ]
    });
  } catch (err) {
    console.error('[ChatServer] Gemini proxy error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});
