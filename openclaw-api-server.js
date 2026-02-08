/**
 * LobsterBoard OpenClaw API Server
 * 
 * Provides REST API endpoints for OpenClaw widgets by querying
 * the OpenClaw CLI and formatting responses as JSON.
 * 
 * Usage: node openclaw-api-server.js
 * 
 * Endpoints:
 *   GET /api/status   - Auth mode, version, session info
 *   GET /api/cron     - List of cron jobs
 *   GET /api/activity - Recent session activity (placeholder)
 *   GET /api/logs     - Recent log lines (placeholder)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, 'server.log');

function log(level, message, data = null) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  console.log(entry.trim());
  try {
    fs.appendFileSync(LOG_FILE, entry);
  } catch (e) {
    // If we can't write to log file, just continue
  }
}

// Generate request ID for tracing
function generateRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

// MIME types
const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// Cache for expensive operations (refresh every 30s)
let statusCache = { data: null, timestamp: 0 };
let cronCache = { data: null, timestamp: 0 };
const CACHE_TTL = 30000; // 30 seconds

// ─────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────

function sendSuccess(res, data, requestId) {
  res.writeHead(200, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Request-Id': requestId
  });
  res.end(JSON.stringify({ status: 'ok', data }));
}

function sendError(res, message, statusCode = 500, requestId = null) {
  res.writeHead(statusCode, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...(requestId && { 'X-Request-Id': requestId })
  });
  res.end(JSON.stringify({ status: 'error', message }));
}

// ─────────────────────────────────────────────
// OPENCLAW CLI
// ─────────────────────────────────────────────

// Run openclaw CLI command and return output
function runOpenClawCmd(args) {
  try {
    const result = execSync(`openclaw ${args}`, { 
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result;
  } catch (e) {
    log('ERROR', `openclaw ${args} failed`, { error: e.message });
    return null;
  }
}

// Parse openclaw status output
function parseStatus() {
  const now = Date.now();
  if (statusCache.data && (now - statusCache.timestamp) < CACHE_TTL) {
    log('DEBUG', 'Status cache hit');
    return statusCache.data;
  }

  log('DEBUG', 'Status cache miss, fetching...');
  const output = runOpenClawCmd('status');
  if (!output) {
    return null;
  }

  // Get current running version
  const versionOutput = runOpenClawCmd('--version');
  const currentVersion = versionOutput ? versionOutput.trim() : 'unknown';

  // Parse the status table
  const data = {
    authMode: 'unknown',
    version: currentVersion,
    sessions: 0,
    gateway: 'unknown'
  };

  // Look for auth info - check for oauth/claude-cli pattern
  // Note: "auth token" in Gateway line refers to gateway auth, not Anthropic
  if (output.includes('oauth') || output.includes('claude-cli')) {
    data.authMode = 'oauth';
  } else if (output.includes('api-key') || output.match(/sk-ant-/)) {
    data.authMode = 'api-key';
  } else {
    // Default to oauth if we can't determine (better than guessing api-key)
    data.authMode = 'oauth';
  }

  // Look for version
  const versionMatch = output.match(/npm update ([\d.-]+)/);
  if (versionMatch) {
    data.latestVersion = versionMatch[1];
  }

  // Look for current version in Update line
  const updateLine = output.match(/Update\s*│\s*([^│]+)/);
  if (updateLine) {
    data.updateInfo = updateLine[1].trim();
  }

  // Look for sessions count
  const sessionsMatch = output.match(/sessions?\s+(\d+)/i);
  if (sessionsMatch) {
    data.sessions = parseInt(sessionsMatch[1]);
  }

  // Look for gateway status
  if (output.includes('running')) {
    data.gateway = 'running';
  }

  statusCache = { data, timestamp: now };
  return data;
}

// Parse cron jobs
function parseCronJobs() {
  const now = Date.now();
  if (cronCache.data && (now - cronCache.timestamp) < CACHE_TTL) {
    log('DEBUG', 'Cron cache hit');
    return cronCache.data;
  }

  log('DEBUG', 'Cron cache miss, fetching...');
  // Get cron jobs via CLI (correct command: openclaw cron list --json)
  const output = runOpenClawCmd('cron list --json');
  
  let jobs = [];
  try {
    if (output) {
      const parsed = JSON.parse(output);
      // The CLI returns { jobs: [...] }
      jobs = parsed.jobs || [];
    }
  } catch (e) {
    log('ERROR', 'Failed to parse cron jobs', { error: e.message });
  }

  const data = { jobs };
  cronCache = { data, timestamp: now };
  return data;
}

// ─────────────────────────────────────────────
// API HANDLERS
// ─────────────────────────────────────────────

const API_HANDLERS = {
  '/api/status': (req, res, requestId) => {
    const startTime = Date.now();
    try {
      const data = parseStatus();
      if (!data) {
        log('ERROR', 'Failed to get status', { requestId });
        sendError(res, 'Failed to get OpenClaw status', 500, requestId);
        return;
      }
      log('INFO', 'GET /api/status', { requestId, responseTime: Date.now() - startTime });
      sendSuccess(res, data, requestId);
    } catch (e) {
      log('ERROR', 'Status handler error', { requestId, error: e.message, stack: e.stack });
      sendError(res, 'Internal server error', 500, requestId);
    }
  },

  '/api/cron': (req, res, requestId) => {
    const startTime = Date.now();
    try {
      const data = parseCronJobs();
      log('INFO', 'GET /api/cron', { requestId, responseTime: Date.now() - startTime });
      sendSuccess(res, data, requestId);
    } catch (e) {
      log('ERROR', 'Cron handler error', { requestId, error: e.message, stack: e.stack });
      sendError(res, 'Internal server error', 500, requestId);
    }
  },

  '/api/activity': (req, res, requestId) => {
    const startTime = Date.now();
    try {
      // Placeholder - would need to query session history
      const data = {
        items: [
          { text: 'Activity feed coming soon', time: new Date().toISOString() }
        ]
      };
      log('INFO', 'GET /api/activity', { requestId, responseTime: Date.now() - startTime });
      sendSuccess(res, data, requestId);
    } catch (e) {
      log('ERROR', 'Activity handler error', { requestId, error: e.message, stack: e.stack });
      sendError(res, 'Internal server error', 500, requestId);
    }
  },

  '/api/logs': (req, res, requestId) => {
    const startTime = Date.now();
    try {
      // Try to read recent logs
      let lines = ['Log viewer coming soon'];
      
      // Try common log locations
      const logPaths = [
        path.join(process.env.HOME, '.config/openclaw/logs/gateway.log'),
        path.join(process.env.HOME, 'Library/Logs/openclaw/gateway.log'),
        '/var/log/openclaw/gateway.log'
      ];

      for (const logPath of logPaths) {
        try {
          if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            lines = content.split('\n').slice(-100).filter(l => l.trim());
            log('DEBUG', 'Found log file', { path: logPath });
            break;
          }
        } catch (e) {
          // Continue to next path
        }
      }

      log('INFO', 'GET /api/logs', { requestId, responseTime: Date.now() - startTime, lineCount: lines.length });
      sendSuccess(res, { lines }, requestId);
    } catch (e) {
      log('ERROR', 'Logs handler error', { requestId, error: e.message, stack: e.stack });
      sendError(res, 'Internal server error', 500, requestId);
    }
  },

  '/api/sessions': (req, res, requestId) => {
    const startTime = Date.now();
    try {
      const status = parseStatus();
      const count = status?.sessions || 0;
      log('INFO', 'GET /api/sessions', { requestId, responseTime: Date.now() - startTime });
      sendSuccess(res, { count }, requestId);
    } catch (e) {
      log('ERROR', 'Sessions handler error', { requestId, error: e.message, stack: e.stack });
      sendError(res, 'Internal server error', 500, requestId);
    }
  }
};

// ─────────────────────────────────────────────
// STATIC FILE SERVER
// ─────────────────────────────────────────────

function serveStatic(filePath, res, requestId) {
  if (filePath === '/') filePath = '/index.html';
  const fullPath = path.resolve(__dirname, '.' + filePath);
  
  // Prevent path traversal attacks
  if (!fullPath.startsWith(path.resolve(__dirname))) {
    log('WARN', 'Path traversal attempt blocked', { requestId, path: filePath });
    sendError(res, 'Forbidden', 403, requestId);
    return;
  }
  
  const ext = path.extname(fullPath).toLowerCase();
  
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        log('ERROR', 'Static file error', { requestId, path: filePath, error: err.message });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const requestId = generateRequestId();
  const pathname = new URL(req.url, 'http://' + req.headers.host).pathname;
  
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Request-Id': requestId
    });
    res.end();
    return;
  }
  
  // API endpoints
  if (API_HANDLERS[pathname]) {
    API_HANDLERS[pathname](req, res, requestId);
    return;
  }
  
  // Static files
  serveStatic(pathname, res, requestId);
});

// Handle server errors
server.on('error', (err) => {
  log('ERROR', 'Server error', { error: err.message, stack: err.stack });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM, shutting down...');
  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT, shutting down...');
  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
});

server.listen(PORT, HOST, () => {
  log('INFO', 'Server started', { host: HOST, port: PORT });
  console.log(`
🦞 LobsterBoard OpenClaw API Server

   Dashboard: http://${HOST}:${PORT}
   
   API Endpoints:
   • /api/status   - Auth mode & version
   • /api/cron     - Cron jobs list
   • /api/activity - Activity feed
   • /api/logs     - System logs
   • /api/sessions - Session count
   
${HOST === '127.0.0.1' ? '   ✓ Bound to localhost (secure)\n' : '   ⚠️  Exposed to network\n'}
   Press Ctrl+C to stop
`);
});
