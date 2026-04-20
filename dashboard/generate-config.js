/**
 * Generates config.js dynamically on Cloud Run startup.
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const configContent = `/**
 * AUTO-GENERATED at runtime — DO NOT EDIT
 */
window.NEXGATE_CONFIG = {
  FIREBASE: {
    apiKey: "${process.env.FIREBASE_API_KEY || ''}",
    authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
    databaseURL: "${process.env.FIREBASE_DATABASE_URL || ''}",
    projectId: "${process.env.FIREBASE_PROJECT_ID || ''}",
    storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET || ''}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID || ''}",
    appId: "${process.env.FIREBASE_APP_ID || ''}",
    measurementId: "${process.env.FIREBASE_MEASUREMENT_ID || ''}"
  }
};
`;

const outPath = resolve(__dirname, 'config.js');
writeFileSync(outPath, configContent, 'utf-8');
console.log(`[OK] Generated config.js successfully.`);
