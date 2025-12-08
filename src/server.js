const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const subscriptionRoutes = require('./routes/subscriptions');
const authRoutes = require('./routes/auth');
const organizationRoutes = require('./routes/organizations');
const appRoutes = require('./routes/app');
const formRoutes = require('./routes/forms');

const app = express();
const PORT = process.env.PORT || 3000;
const MONITORING_PORT = process.env.MONITORING_PORT || 3334;
const IS_DEV = process.env.NODE_ENV !== 'production';
const sseClients = new Map();
const sseEventStore = new Map();
const sseEventOrder = new Map();

app.set('etag', 'strong');

// Middleware de seguridad
app.use(helmet());
const shouldCompress = (req, res) => {
  if (req.path && req.path.startsWith('/api/streams/')) return false;
  return compression.filter(req, res);
};
app.use(compression({ filter: shouldCompress }));
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_DEV ? 1000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.path === '/health'
});
app.use(limiter);

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Metrics monitoring
const { metricsMiddleware, getSnapshot, resetMetrics } = require('../monitoring/metricsMiddleware');
const { startMonitoringServer } = require('../monitoring/monitoringServer');
app.use(metricsMiddleware);

// SSE: stream user request activity in real-time
app.get('/api/streams/user-requests/:id', (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`event: ping\n`);
  res.write(`data: {"status":"connected"}\n\n`);
  if (!sseClients.has(id)) sseClients.set(id, new Set());
  const set = sseClients.get(id);
  set.add(res);
  req.on('close', () => {
    const s = sseClients.get(id);
    if (s) { s.delete(res); if (s.size === 0) sseClients.delete(id); }
  });
});

// Middleware to broadcast request/response events keyed by actor/user id
app.use((req, res, next) => {
  try {
    if (req.path.startsWith('/api/streams/user-requests') || req.path === '/health') return next();
    const getActorId = () => {
      const hdr = req.headers['x-user-id'] || req.headers['x-actor-id'];
      if (hdr) return String(hdr);
      const auth = req.headers.authorization || '';
      const [, token] = auth.split(' ');
      if (token) {
        try { const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); return payload?.sub || null; } catch {}
      }
      if (req.query.userid) return String(req.query.userid);
      if (req.query.userId) return String(req.query.userId);
      if (req.body && req.body.userId) return String(req.body.userId);
      return null;
    };

    let actorId = getActorId();
    if (!actorId && req.originalUrl) {
      const m = req.originalUrl.match(/\/users\/([a-zA-Z0-9\-]+)/);
      if (m && m[1]) actorId = m[1];
    }
    let responseBody; const origJson = res.json.bind(res); const origSend = res.send.bind(res);
    res.json = function (body) { responseBody = body; return origJson(body); };
    res.send = function (body) { responseBody = body; return origSend(body); };
    res.on('finish', () => {
      try {
        if (!actorId) return;
        const clients = sseClients.get(actorId);
        if (!clients || clients.size === 0) return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const fullEvent = {
          id,
          endpoint: `${req.method} ${req.originalUrl}`,
          status: res.statusCode,
          payload: req.body || null,
          response: responseBody || null,
          date: Date.now()
        };
        const stringifySafe = (obj) => {
          try { return JSON.stringify(obj); } catch { return typeof obj === 'string' ? obj : String(obj); }
        };
        const payloadText = stringifySafe(fullEvent.payload || null);
        const responseText = stringifySafe(fullEvent.response || null);
        const snippet = (txt) => {
          if (!txt) return '';
          return txt.length > 300 ? txt.slice(0, 300) + '…' : txt;
        };
        const event = {
          id,
          endpoint: fullEvent.endpoint,
          status: fullEvent.status,
          payloadSnippet: snippet(payloadText),
          responseSnippet: snippet(responseText),
          date: fullEvent.date
        };
        if (!sseEventStore.has(actorId)) sseEventStore.set(actorId, new Map());
        if (!sseEventOrder.has(actorId)) sseEventOrder.set(actorId, []);
        const store = sseEventStore.get(actorId);
        const order = sseEventOrder.get(actorId);
        store.set(id, fullEvent);
        order.unshift(id);
        if (order.length > 500) {
          const oldId = order.pop();
          store.delete(oldId);
        }
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) {
          try { client.write(data); } catch {}
        }
      } catch {}
    });
  } catch {}
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API Routes
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/app', appRoutes);
app.use('/api/forms', formRoutes);

app.get('/api/streams/user-requests/:id/events/:eventId', (req, res) => {
  const { id, eventId } = req.params;
  const store = sseEventStore.get(id);
  if (!store) return res.status(404).json({ error: 'No events for user' });
  const ev = store.get(eventId);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const normalize = (v) => {
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = normalize(v[k]);
      return out;
    }
    return v;
  };
  res.json(normalize(ev));
});

// Webhook para eventos de emergencia del emisor Python
app.post('/api/hooks/emergency', (req, res) => {
  const { id, channelId, content, createdAt } = req.body || {};
  if (!id || !channelId || !content) {
    return res.status(400).json({ error: 'Payload inválido', required: ['id', 'channelId', 'content'] });
  }
  console.log('[hook] emergency event', {
    id,
    channelId,
    content: (String(content).length > 100 ? String(content).slice(0, 100) + '…' : content),
    createdAt
  });
  res.json({ status: 'received', id, channelId, at: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Algo salió mal!',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Export for Vercel
module.exports = app;

// Only start server if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    try {
      startMonitoringServer({ getSnapshot, resetMetrics, port: MONITORING_PORT });
    } catch (e) {
      console.error('Failed to start monitoring server', e);
    }
  });
}