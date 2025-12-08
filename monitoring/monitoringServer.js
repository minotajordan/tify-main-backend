const express = require('express');
const cors = require('cors');

function startMonitoringServer({ getSnapshot, resetMetrics, port }) {
  const app = express();
  const clients = new Set();

  app.use(cors({ origin: '*', credentials: false }));
  app.use(express.json());

  app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    res.write(`event: ping\n`);
    res.write(`data: {"status":"connected"}\n\n`);

    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
    });
  });

  app.post('/reset', (req, res) => {
    resetMetrics();
    res.json({ status: 'reset' });
  });

  const server = app.listen(port, () => {
    console.log(`📈 Monitoring server listening on ${port}`);
    console.log(`🔌 SSE: http://localhost:${port}/stream`);
  });

  const interval = setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = getSnapshot();
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      try { client.write(payload); } catch {}
    }
  }, 1000);

  server.on('close', () => clearInterval(interval));

  return { app, server };
}

module.exports = { startMonitoringServer };