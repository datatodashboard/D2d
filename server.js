import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const HOST = '0.0.0.0';

// Health check endpoints for Cloud Run, load balancers, and monitoring
app.get(['/health', '/healthz', '/_health'], (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files from root
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    } else if (filePath.endsWith('.data')) {
      res.setHeader('Content-Type', 'application/octet-stream');
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
