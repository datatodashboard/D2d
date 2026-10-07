import http from 'http';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { evaluateThinking, PASS_THRESHOLD } from './js/thinking.js';

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
  const passed = score >= PASS_THRESHOLD;

  return res.json({
    scenarioId,
    assessment,
    score,
    passed
  });
});

// Trusted Backend Completion Verification Route
// Validates completion using trusted scoring logic; does not accept or trust client-supplied score or userId
app.post('/api/progress/complete', (req, res) => {
  const { scenarioId, thinking } = req.body || {};

  if (!scenarioId || !scenariosMap.has(scenarioId)) {
    return res.status(400).json({
      success: false,
      error: `Invalid scenario ID: "${scenarioId}". Not found in trusted scenario catalog.`
    });
  }

  const scenario = scenariosMap.get(scenarioId);
  const assessment = evaluateThinking(scenario, thinking || {});
  const score = typeof assessment?.score === 'number' ? assessment.score : 0;
  const passed = score >= PASS_THRESHOLD;

  if (!passed) {
    return res.status(422).json({
      success: false,
      passed: false,
      score,
      message: `Thinking score of ${score}/10 does not meet the passing threshold (>= ${PASS_THRESHOLD}/10).`
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

// Static assets options
const staticOptions = {
  dotfiles: 'ignore',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.data')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.json') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
};

// Serve strictly allow-listed static directories
app.use('/js', express.static(path.join(__dirname, 'js'), staticOptions));
app.use('/data', express.static(path.join(__dirname, 'data'), staticOptions));
app.use('/vendor', express.static(path.join(__dirname, 'vendor'), staticOptions));
app.use('/public', express.static(path.join(__dirname, 'public'), staticOptions));

// Explicitly allow-listed root assets
const ALLOWED_ROOT_FILES = [
  'index.html',
  'admin.html',
  'manifest.json',
  'sw.js',
  'apple-touch-icon.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'icon-maskable-512.jpeg',
  'd2d-logo.svg',
  'thinking-chime.mp3'
];

ALLOWED_ROOT_FILES.forEach(fileName => {
  app.get(`/${fileName}`, (req, res) => {
    const filePath = path.join(__dirname, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('Not Found');
    if (fileName.endsWith('.js') || fileName.endsWith('.json') || fileName.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    res.sendFile(filePath);
  });
});

// Explicit navigation routes
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/admin', '/admin.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Unknown /api/* paths -> 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Navigation fallback for extension-less routes, 404 for files with extensions
app.use((req, res) => {
  const ext = path.extname(req.path);
  if (!ext) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  res.status(404).type('text/plain').send('Not Found');
});

// Error handling middleware for malformed JSON and server errors
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api') || req.url.startsWith('/api')) {
    if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400)) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    return res.status(err.status || err.statusCode || 500).json({ error: 'Invalid request' });
  }
  return res.status(err.status || err.statusCode || 500).send('Error');
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
