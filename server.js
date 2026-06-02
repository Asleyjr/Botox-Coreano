const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const logFile = path.join(__dirname, 'server_activity.log');
// Clear the log on startup
fs.writeFileSync(logFile, '', 'utf8');
const originalLog = console.log;
console.log = function(...args) {
  originalLog.apply(console, args);
  try {
    fs.appendFileSync(logFile, args.join(' ') + '\n', 'utf8');
  } catch (err) {}
};

const PORT = 8080;
const PROXY_HOST = 'quiz.mimika-app.com';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

const LEADS_FILE = path.join(__dirname, 'leads.json');

// Initialize local database if not exists
if (!fs.existsSync(LEADS_FILE)) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify([], null, 2), 'utf8');
}

// ==========================================
// CONFIGURAÇÃO DO SUPABASE
// ==========================================
// Preencha seu URL e chave Anon abaixo para sincronizar seus leads na nuvem!
const SUPABASE_URL = 'https://gbljtkkcauoztcmviydg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_HhSlmvgoUdZWCakru5F-fw_7A_x8yRu';
// ==========================================

// Função para sincronizar dados com o Supabase via HTTP REST API
function syncToSupabase(table, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  
  try {
    const cleanUrl = SUPABASE_URL.trim().replace(/\/$/, '');
    const hostname = cleanUrl.replace(/^https?:\/\//, '');
    const pathUrl = `/rest/v1/${table}`;
    
    const payload = JSON.stringify(data);
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    };
    
    const options = {
      hostname: hostname,
      port: 443,
      path: pathUrl,
      method: 'POST',
      headers: headers
    };
    
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[SUPABASE] Sincronizado com sucesso na tabela: ${table}`);
        } else {
          console.log(`[SUPABASE ERROR] Status ${res.statusCode}: ${responseBody}`);
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`[SUPABASE ERROR] Falha na requisição: ${err.message}`);
    });
    
    req.write(payload);
    req.end();
  } catch (err) {
    console.log(`[SUPABASE ERROR] Falha geral: ${err.message}`);
  }
}

// Endpoint para registrar eventos de rastreamento do front-end
function handleTrackEvent(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { session_id, type } = payload;
      if (!session_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing session_id' }));
      }

      // Load existing leads
      let leads = [];
      try {
        leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
      } catch (e) {
        leads = [];
      }

      // Find or create session
      let session = leads.find(s => s.session_id === session_id);
      if (!session) {
        session = {
          session_id: session_id,
          created_at: new Date().toISOString(),
          email: '',
          completed: false,
          last_step: 1,
          answers: {}
        };
        leads.push(session);
      }

      // Update session depending on event type
      if (type === 'step') {
        const step = payload.step || 1;
        if (step > session.last_step) {
          session.last_step = step;
        }
      } else if (type === 'answer') {
        const { question, answer, step } = payload;
        if (question && answer) {
          session.answers[question] = answer;
          if (step && step > session.last_step) {
            session.last_step = step;
          }
        }
        
        // Sync response with Supabase
        syncToSupabase('funnel_responses', {
          session_id: session_id,
          step_name: `Etapa ${step || session.last_step}`,
          question: question,
          answer: answer
        });
      } else if (type === 'email') {
        const email = payload.email || '';
        if (email) {
          session.email = email;
        }
      } else if (type === 'complete') {
        session.completed = true;
      }

      // Save locally
      fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');

      // Sync session with Supabase
      syncToSupabase('funnel_sessions', {
        id: session_id,
        email: session.email,
        completed: session.completed,
        last_step: session.last_step
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.log('[ERROR] Failed to handle track-event:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// Endpoint para recuperar dados agregados da Dashboard
function handleDashboardMetrics(req, res) {
  try {
    let leads = [];
    if (fs.existsSync(LEADS_FILE)) {
      leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    }

    const totalVisits = leads.length;
    const leadsAcquired = leads.filter(s => s.last_step > 1 || Object.keys(s.answers).length > 0).length;
    const interactionRate = totalVisits > 0 ? ((leadsAcquired / totalVisits) * 100).toFixed(1) : '0.0';
    const qualifiedLeads = leads.filter(s => s.last_step >= 15 || Object.keys(s.answers).length >= 5).length;
    const completedFlows = leads.filter(s => s.completed || s.last_step >= 31).length;

    // Filter leads to return lists of recent responses
    const recentLeads = leads.map(s => ({
      session_id: s.session_id,
      created_at: s.created_at,
      email: s.email || 'Não informado',
      completed: s.completed ? 'Sim' : 'Não',
      last_step: s.last_step,
      answers: s.answers
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      metrics: {
        totalVisits,
        leadsAcquired,
        interactionRate,
        qualifiedLeads,
        completedFlows
      },
      leads: recentLeads
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// Endpoint para resetar os dados locais
function handleDashboardReset(req, res) {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify([], null, 2), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

const ROOT = __dirname;

function serveFile(res, filePath, req) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let data = fs.readFileSync(filePath);
  
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const headers = {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  };

  if (acceptEncoding.includes('gzip') && (mime.startsWith('text/') || mime === 'application/javascript' || mime === 'application/json')) {
    try {
      data = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    } catch (err) {
      console.log('[ERROR] Gzip compression failed:', err.message);
    }
  }

  res.writeHead(200, headers);
  res.end(data);
}

function proxyRequest(req, res) {
  const options = {
    hostname: PROXY_HOST,
    port: 443,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: PROXY_HOST },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.writeHead(502);
    res.end('Proxy error');
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // Intercept our local dashboard and tracking endpoints
  if (urlPath.startsWith('/api/')) {
    if (urlPath === '/api/track-event') {
      return handleTrackEvent(req, res);
    }
    if (urlPath === '/api/dashboard-metrics') {
      return handleDashboardMetrics(req, res);
    }
    if (urlPath === '/api/dashboard-reset') {
      return handleDashboardReset(req, res);
    }
    
    console.log(`[PROXY] ${req.method} ${req.url}`);
    return proxyRequest(req, res);
  }

  // Intercept paywall chunk requests to force browser redirect to sales page
  if (urlPath.includes('new-plan-paywall') && urlPath.endsWith('.js')) {
    console.log(`[REDIRECT] Forcing client reload to /vendas for chunk request: ${urlPath}`);
    res.writeHead(200, { 
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });
    return res.end("window.location.href = '/vendas';");
  }

  // Serve index.html for root and /quiz
  if (urlPath === '/' || urlPath === '/quiz') {
    urlPath = '/index.html';
  }

  // Serve sales page for paywall and /vendas
  if (urlPath === '/new-plan-paywall' || urlPath === '/vendas') {
    urlPath = '/vendas.html';
  }

  // Serve dashboard.html for /dashboard
  if (urlPath === '/dashboard') {
    urlPath = '/dashboard.html';
  }

  const filePath = path.join(ROOT, urlPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    console.log(`[FILE]  ${urlPath}`);
    return serveFile(res, filePath, req);
  }

  // Fallback: proxy to real server for any missing file
  console.log(`[PROXY fallback] ${req.url}`);
  proxyRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`\n Quiz rodando em: http://localhost:${PORT}\n`);
  console.log(' Arquivos locais + API proxied para quiz.mimika-app.com');
  console.log(' Pressione Ctrl+C para parar.\n');
});
