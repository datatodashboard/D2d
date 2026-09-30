import http from 'http';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { evaluateThinking } from './js/thinking.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const HOST = '0.0.0.0';

// Enable JSON request body parsing
app.use(express.json());

// Load authoritative scenario catalog
const scenariosPath = path.join(__dirname, 'data', 'scenarios.json');
let scenariosMap = new Map();
try {
  const scenariosRaw = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  scenariosMap = new Map((scenariosRaw.scenarios || []).map(s => [s.id, s]));
  console.log(`[Backend Catalog] Loaded ${scenariosMap.size} trusted scenarios.`);
} catch (loadErr) {
  console.error('[Backend Catalog] Error loading scenarios.json:', loadErr);
}

// Health check endpoints for Cloud Run, load balancers, and monitoring
app.get(['/health', '/healthz', '/_health'], (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Trusted Scenario Catalog API
app.get('/api/scenarios/catalog', (req, res) => {
  res.json({
    total: scenariosMap.size,
    ids: Array.from(scenariosMap.keys())
  });
});

// Trusted Backend Thinking Evaluation Route
// Evaluates learner thinking using the authoritative evaluator in Node.js
app.post('/api/evaluate-thinking', (req, res) => {
  const { scenarioId, thinking } = req.body || {};

  if (!scenarioId || !scenariosMap.has(scenarioId)) {
    return res.status(400).json({
      error: `Invalid scenario ID: "${scenarioId}". Not found in trusted scenario catalog.`
    });
  }

  const scenario = scenariosMap.get(scenarioId);
  const assessment = evaluateThinking(scenario, thinking || {});
  const score = typeof assessment?.score === 'number' ? assessment.score : 0;
  const passed = score >= 7;

  return res.json({
    scenarioId,
    assessment,
    score,
    passed
  });
});

// Trusted Backend Completion Verification Route
// Validates completion using trusted scoring logic; does not accept client-supplied score
app.post('/api/progress/complete', (req, res) => {
  const { scenarioId, thinking, userId } = req.body || {};

  if (!scenarioId || !scenariosMap.has(scenarioId)) {
    return res.status(400).json({
      success: false,
      error: `Invalid scenario ID: "${scenarioId}". Not found in trusted scenario catalog.`
    });
  }

  const scenario = scenariosMap.get(scenarioId);
  const assessment = evaluateThinking(scenario, thinking || {});
  const score = typeof assessment?.score === 'number' ? assessment.score : 0;
  const passed = score >= 7;

  if (!passed) {
    return res.status(422).json({
      success: false,
      passed: false,
      score,
      message: `Thinking score of ${score}/10 does not meet the passing threshold (>= 7/10).`
    });
  }

  return res.json({
    success: true,
    passed: true,
    scenarioId,
    score,
    assessment
  });
});

// Serve static files from root
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.data')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.json') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Route fallback to index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Port configuration:
// Port 3000 is the hardcoded application port routed by the container's Nginx reverse proxy.
// In both AI Studio development and deployed Cloud Run, Nginx handles port 8080 and proxies traffic to port 3000.
const PORT = 3000;

const server = app.listen(PORT, HOST, () => {
  console.log(`Think and Crack SQL server running at http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
});

// Graceful termination
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    process.exit(0);
  });
});
