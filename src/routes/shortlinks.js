const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const getDomain = (req) => {
  // If explicitly set in env (e.g. for custom domain in production), use it
  if (process.env.SHORTLINK_DOMAIN) return process.env.SHORTLINK_DOMAIN;
  
  // Otherwise, infer from request headers (works for localhost and Vercel/proxies)
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost) return Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  
  return req.headers.host || 'board.tify.pro';
};

const getProtocol = (req) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto) return Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return req.protocol || 'https';
};

const generateCode = async () => {
  const make = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  let code = make();
  // Ensure uniqueness
  for (let i = 0; i < 5; i++) {
    const exists = await prisma.shortLink.findUnique({ where: { code } }).catch(() => null);
    if (!exists) return code;
    code = make();
  }
  return code;
};

const getActorId = (req) => {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
      return payload?.sub || null;
    } catch {}
  }
  return null;
};

const toIso = (v) => (v ? new Date(v) : null);

// Create short link
router.post('/', async (req, res) => {
  try {
    const {
      targetUrl,
      redirectMode = 'IMMEDIATE',
      interstitialTitle,
      interstitialMessage,
      bannerImageUrl,
      activeFrom,
      expiresAt,
      generateQr = true
    } = req.body || {};

    if (!targetUrl || typeof targetUrl !== 'string') {
      return res.status(400).json({ error: 'targetUrl requerido' });
    }
    const actorId = getActorId(req);
    const code = await generateCode();
    const short = await prisma.shortLink.create({
      data: {
        code,
        targetUrl,
        createdBy: actorId || null,
        redirectMode,
        interstitialTitle: interstitialTitle || null,
        interstitialMessage: interstitialMessage || null,
        bannerImageUrl: bannerImageUrl || null,
        activeFrom: activeFrom ? toIso(activeFrom) : null,
        expiresAt: expiresAt ? toIso(expiresAt) : null
      }
    });

    let qrPayload = null;
    if (generateQr) {
      const url = `https://${getDomain(req)}/L${short.code}`;
      try {
        const svg = await QRCode.toString(url, { type: 'svg' });
        const qr = await prisma.shortLinkQr.upsert({
          where: { shortLinkId: short.id },
          update: { format: 'SVG', data: svg },
          create: { shortLinkId: short.id, format: 'SVG', data: svg }
        });
        qrPayload = { format: qr.format, data: qr.data };
      } catch (e) {
        qrPayload = null;
      }
    }

    res.status(201).json({
      ...short,
      shortUrl: `https://${getDomain(req)}/L${short.code}`,
      qr: qrPayload
    });
  } catch (error) {
    res.status(500).json({ error: 'Error creando shortlink', details: error.message });
  }
});

// Extract metadata from URL
router.post('/extract-metadata', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    
    // Validate URL format
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'URL inválida' });
    }

    const response = await fetch(url, { headers: { 'User-Agent': 'TifyBot/1.0' } });
    if (!response.ok) throw new Error('Failed to fetch URL');
    const html = await response.text();
    
    // Simple regex extraction
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || 
                       html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const title = titleMatch ? titleMatch[1] : '';
    
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
                      html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const description = descMatch ? descMatch[1] : '';
    
    const imgMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    const image = imgMatch ? imgMatch[1] : '';

    res.json({ title, description, image });
  } catch (error) {
    console.error('Metadata extraction error:', error);
    // Return empty but success to avoid breaking UI
    res.json({ title: '', description: '', image: '' });
  }
});

// Get global stats (Dashboard)
router.get('/stats', async (req, res) => {
  try {
    const { createdBy } = req.query;
    const whereUser = createdBy ? { createdBy } : {};
    
    // For visits, we filter by the shortLink's creator
    const whereVisits = createdBy ? { shortLink: { createdBy } } : {};

    const [totalLinks, totalClicks, activeLinks, recentVisits] = await Promise.all([
      prisma.shortLink.count({ where: whereUser }),
      prisma.shortLinkVisit.count({ where: whereVisits }),
      prisma.shortLink.count({ where: { ...whereUser, isActive: true } }),
      prisma.shortLinkVisit.findMany({
        where: whereVisits,
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { shortLink: { select: { code: true, targetUrl: true } } }
      })
    ]);

    // Chart data: last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const visitsRange = await prisma.shortLinkVisit.findMany({
      where: { 
        ...whereVisits,
        createdAt: { gte: thirtyDaysAgo }
      },
      select: { createdAt: true }
    });
    
    const historyMap = {};
    // Initialize last 30 days with 0
    for (let i = 0; i < 30; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        historyMap[dateStr] = 0;
    }

    visitsRange.forEach(v => {
      const date = v.createdAt.toISOString().split('T')[0];
      if (historyMap[date] !== undefined) {
        historyMap[date]++;
      }
    });
    
    const chartData = Object.entries(historyMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a,b) => a.date.localeCompare(b.date));

    res.json({
      totalLinks,
      totalClicks,
      activeLinks,
      recentVisits,
      chartData
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Error fetching stats', details: error.message });
  }
});

// List short links (optionally by creator)
router.get('/', async (req, res) => {
  try {
    const { createdBy, page = '1', limit = '20', search } = req.query;
    const p = parseInt(page);
    const l = parseInt(limit);
    const skip = (p - 1) * l;
    const where = {
      AND: [
        createdBy ? { createdBy } : {},
        search
          ? {
              OR: [
                { targetUrl: { contains: String(search) } },
                { code: { contains: String(search).toUpperCase() } }
              ]
            }
          : {}
      ]
    };
    const [items, total] = await Promise.all([
      prisma.shortLink.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: l }),
      prisma.shortLink.count({ where })
    ]);
    const protocol = getProtocol(req);
    res.json({
      items: items.map((s) => ({
        ...s,
        shortUrl: `${protocol}://${getDomain(req)}/L${s.code}`
      })),
      pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error listando shortlinks', details: error.message });
  }
});

// Get details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const s = await prisma.shortLink.findUnique({ where: { id } });
    if (!s) return res.status(404).json({ error: 'Shortlink no encontrado' });
    const qr = await prisma.shortLinkQr.findUnique({ where: { shortLinkId: id } }).catch(() => null);
    const protocol = getProtocol(req);
    res.json({
      ...s,
      shortUrl: `${protocol}://${getDomain(req)}/L${s.code}`,
      qr: qr ? { format: qr.format, data: qr.data } : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo shortlink', details: error.message });
  }
});

// Update (and record change history)
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.shortLink.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Shortlink no encontrado' });

    const data = {};
    const changes = {};
    const fields = [
      'targetUrl',
      'redirectMode',
      'interstitialTitle',
      'interstitialMessage',
      'bannerImageUrl',
      'activeFrom',
      'expiresAt',
      'isActive'
    ];
    for (const f of fields) {
      if (f in req.body) {
        const val =
          f === 'activeFrom' || f === 'expiresAt' ? (req.body[f] ? toIso(req.body[f]) : null) : req.body[f];
        data[f] = val;
        changes[f] = { from: existing[f], to: val };
      }
    }
    const updated = await prisma.shortLink.update({ where: { id }, data });
    const actorId = getActorId(req);
    const changeType =
      'targetUrl' in data
        ? 'TARGET_UPDATE'
        : 'redirectMode' in data
        ? 'MODE_UPDATE'
        : 'interstitialTitle' in data || 'interstitialMessage' in data || 'bannerImageUrl' in data
        ? 'INTERSTITIAL_UPDATE'
        : 'activeFrom' in data || 'expiresAt' in data
        ? 'WINDOW_UPDATE'
        : 'isActive' in data
        ? updated.isActive
          ? 'ACTIVATE'
          : 'DEACTIVATE'
        : 'TARGET_UPDATE';
    await prisma.shortLinkChange.create({
      data: {
        shortLinkId: id,
        changedBy: actorId || null,
        changeType,
        previousValues: existing,
        newValues: updated
      }
    });
    const protocol = getProtocol(req);
    res.json({
      ...updated,
      shortUrl: `${protocol}://${getDomain(req)}/L${updated.code}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando shortlink', details: error.message });
  }
});

// Delete
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.shortLink.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: 'Error eliminando shortlink', details: error.message });
  }
});

// History
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const items = await prisma.shortLinkChange.findMany({
      where: { shortLinkId: id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo historial', details: error.message });
  }
});

// Generate or refresh QR
router.post('/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const s = await prisma.shortLink.findUnique({ where: { id } });
    if (!s) return res.status(404).json({ error: 'Shortlink no encontrado' });
    const protocol = getProtocol(req);
    const url = `${protocol}://${getDomain(req)}/L${s.code}`;
    const svg = await QRCode.toString(url, { type: 'svg' });
    const qr = await prisma.shortLinkQr.upsert({
      where: { shortLinkId: id },
      update: { format: 'SVG', data: svg },
      create: { shortLinkId: id, format: 'SVG', data: svg }
    });
    res.json({ format: qr.format, data: qr.data });
  } catch (error) {
    res.status(500).json({ error: 'Error generando QR', details: error.message });
  }
});

// Serve QR
router.get('/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const qr = await prisma.shortLinkQr.findUnique({ where: { shortLinkId: id } });
    if (!qr) return res.status(404).json({ error: 'QR no encontrado' });
    if (qr.format === 'SVG') {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      return res.send(qr.data);
    }
    res.json(qr);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo QR', details: error.message });
  }
});

// Public redirect route: /L<code>
router.get('/L:code', async (req, res) => {
  try {
    const { code } = req.params;
    const s = await prisma.shortLink.findUnique({ where: { code } });
    if (!s || !s.isActive) {
      return res.status(404).send('Link no disponible');
    }
    const now = new Date();
    if (s.activeFrom && now < s.activeFrom) {
      return res.status(403).send('Link aún no activo');
    }
    if (s.expiresAt && now > s.expiresAt) {
      return res.status(410).send('Link expirado');
    }
    // Log visit
    try {
      await prisma.shortLinkVisit.create({
        data: {
          shortLinkId: s.id,
          ip: req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
          referer: req.headers['referer'] || null
        }
      });
    } catch {}

    if (s.redirectMode === 'IMMEDIATE') {
      return res.redirect(302, s.targetUrl);
    }

    // Interstitial HTML with optional content and a button
    const title = s.interstitialTitle || 'Redirección';
    const message =
      s.interstitialMessage ||
      'Serás redirigido al destino. Si no ocurre automáticamente, usa el botón.';
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${message}">
  <meta property="og:image" content="${s.bannerImageUrl || ''}">
  <meta name="twitter:card" content="summary_large_image">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin:0; padding:0; background:#0f172a; color:#e2e8f0; }
    .wrap { max-width: 660px; margin: 0 auto; padding: 24px; }
    .card { background:#111827; border:1px solid #1f2937; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); overflow:hidden; }
    .banner { display: ${s.bannerImageUrl ? 'block' : 'none'}; background:#000; }
    .banner img { width:100%; height:auto; display:block; }
    .content { padding: 20px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 16px; line-height: 1.5; }
    .url { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; background:#0b1220; padding:8px 10px; border-radius:8px; border:1px solid #1f2937; color:#93c5fd; word-break: break-all;}
    .actions { margin-top: 16px; display:flex; gap:12px; }
    .btn { appearance: none; border: none; border-radius: 8px; padding: 10px 14px; font-weight: 600; cursor: pointer; }
    .primary { background:#2563eb; color:white; }
    .secondary { background:#374151; color:#e5e7eb; }
    footer { margin-top: 16px; text-align:center; font-size: 12px; color:#9ca3af; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="banner">${s.bannerImageUrl ? `<img src="${s.bannerImageUrl}" alt="">` : ''}</div>
      <div class="content">
        <h1>${title}</h1>
        <p>${message}</p>
        <div class="url">${s.targetUrl}</div>
        <div class="actions">
          <button class="btn primary" onclick="window.location.href='${s.targetUrl}'">Ir ahora</button>
          <button class="btn secondary" onclick="history.back()">Regresar</button>
        </div>
      </div>
    </div>
    <footer>tify.pro · L${s.code}</footer>
  </div>
  <script>
    setTimeout(function(){ window.location.href='${s.targetUrl}'; }, 2000);
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  } catch (error) {
    res.status(500).send('Error procesando redirección');
  }
});

module.exports = router;

