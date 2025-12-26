const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const { Prisma } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const http = require('http');

// GET /api/messages/channel/:channelId - Obtener mensajes de un canal (con filtros en backend)
router.get('/channel/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const skip = (page - 1) * limit;

    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    let viewerId = null;
    if (token) { try { const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); viewerId = payload.sub; } catch {} }

    const {
      q = '',
      quick = 'all',
      priority,
      emergency,
      expired,
      hasApprovals,
      start
    } = req.query;

    const where = { channelId };

    if (q && String(q).trim().length >= 2) {
      const like = `%${q}%`;
      const rows = await prisma.$queryRaw`
        SELECT M.id
        FROM tify_messages M
        INNER JOIN tify_channels C ON M.channel_id = C.id
        WHERE C.id = ${channelId}
          AND M.content LIKE ${like}
      `;
      const ids = rows.map(r => r.id);
      where.id = { in: ids };
    }

    if (start) {
      const dt = new Date(start);
      if (!isNaN(dt.getTime())) where.createdAt = { gte: dt };
    }

    if (priority) where.priority = priority;
    if (typeof emergency !== 'undefined') where.isEmergency = emergency === 'true';
    if (typeof expired !== 'undefined') {
      const now = new Date();
      if (expired === 'true') where.expiresAt = { not: null, lte: now };
      else where.expiresAt = { not: null, gt: now };
    }
    if (typeof hasApprovals !== 'undefined') {
      if (hasApprovals === 'true') where.approvals = { some: { status: { not: 'PENDING' } } };
      else where.approvals = { every: { status: 'PENDING' } };
    }

    if (quick === 'emergency') where.isEmergency = true;
    else if (quick === 'high') where.priority = 'HIGH';
    else if (quick === 'vigent') where.expiresAt = { not: null, gt: new Date() };
    else if (quick === 'expired') where.expiresAt = { not: null, lte: new Date() };
    else if (quick === 'hasApprovals') where.approvals = { some: { status: { not: 'PENDING' } } };
    else if (quick === 'noApprovals') where.approvals = { every: { status: 'PENDING' } };

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: {
          sender: { select: { id: true, username: true, fullName: true } },
          channel: { select: { title: true, icon: true } },
          approvals: { include: { approver: { select: { id: true, username: true, fullName: true } } } },
          _count: { select: { views: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.message.count({ where })
    ]);

    let seenIds = new Set();
    if (viewerId && messages.length > 0) {
      const ids = messages.map(m => m.id);
      const seen = await prisma.messageView.findMany({ where: { messageId: { in: ids }, userId: viewerId }, select: { messageId: true } });
      seenIds = new Set(seen.map(s => s.messageId));
    }

    const augmented = messages.map(m => ({ ...m, viewsCount: m._count?.views || 0, viewedByMe: seenIds.has(m.id) }));

    res.json({ messages: augmented, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('Error obteniendo mensajes:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/messages/:id/public - Obtener mensaje público sin autenticación
router.get('/:id/public', async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await prisma.message.findUnique({
      where: { id },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true, isPublic: true } }
      }
    });

    if (!msg) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }

    if (!msg.channel.isPublic) {
      return res.status(403).json({ error: 'El mensaje pertenece a un canal privado' });
    }

    res.json(msg);
  } catch (error) {
    console.error('Error obteniendo mensaje público:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/messages/:id - Obtener mensaje por id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await prisma.message.findUnique({
      where: { id },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } }
      }
    });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    res.json(msg);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo mensaje' });
  }
});

// POST /api/messages - Crear nuevo mensaje
router.post('/', async (req, res) => {
  try {
  const {
      channelId,
      senderId,
      content,
      categoryId,
      priority = 'MEDIUM',
      isImmediate = false,
      durationSeconds = 30,
      isEmergency = false,
      deliveryMethod = 'PUSH',
      attachments = [],
      eventAt,
      publishedAt: publishedAtInput,
      expiresAt: expiresAtInput,
      extra
    } = req.body;

    if (publishedAtInput && new Date(publishedAtInput) <= new Date()) {
      return res.status(400).json({ error: 'publishedAt must be in the future' });
    }
    if (eventAt && new Date(eventAt) <= new Date()) {
      return res.status(400).json({ error: 'eventAt must be in the future' });
    }
    if (expiresAtInput && new Date(expiresAtInput) <= new Date()) {
      return res.status(400).json({ error: 'expiresAt must be in the future' });
    }

    // Validar longitud del contenido
    if (!content || content.length > 250) {
      return res.status(400).json({ 
        error: 'El contenido es requerido y debe tener máximo 250 caracteres' 
      });
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, verificationStatus: true, approvalPolicy: true }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Canal no encontrado' });
    }

    const category = await prisma.messageCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, name: true, scope: true }
    });

    if (!category) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }

    if (isImmediate && category.name !== 'EMERGENTE') {
      return res.status(400).json({ error: 'Solo la categoría EMERGENTE permite inmediato' });
    }

    if (attachments.length > 0 && !['VERIFIED', 'VERIFIED_CERTIFIED'].includes(channel.verificationStatus)) {
      return res.status(400).json({ error: 'Adjuntos solo en canales verificados/certificados' });
    }

    const expiresAt = expiresAtInput ? new Date(expiresAtInput) : new Date(Date.now() + (durationSeconds * 1000));

    if (eventAt && expiresAt > new Date(eventAt)) {
      return res.status(400).json({ error: 'expiresAt no puede ser mayor que eventAt' });
    }

    const publishedAt = publishedAtInput ? new Date(publishedAtInput) : (channel.approvalPolicy === 'REQUIRED' ? null : new Date());

    const message = await prisma.message.create({
      data: {
        channelId,
        senderId,
        categoryId,
        content,
        durationSeconds,
        expiresAt,
        isEmergency,
        isImmediate,
        priority,
        deliveryMethod,
        eventAt: eventAt ? new Date(eventAt) : null,
        state: 'ACTIVE',
        publishedAt,
        extra
      },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } }
      }
    });

    if (attachments.length > 0) {
      const data = attachments.map(a => ({
        messageId: message.id,
        type: a.type,
        url: a.url,
        metadata: a.metadata || null
      }));
      await prisma.messageAttachment.createMany({ data });
    }

    const subscribers = await prisma.channelSubscription.findMany({
      where: { 
        channelId,
        isActive: true 
      },
      select: { userId: true }
    });

    const deliveries = subscribers.map(sub => ({
      messageId: message.id,
      userId: sub.userId,
      deliveryStatus: 'PENDING',
      deliveryMethod
    }));

    if (deliveries.length > 0) {
      await prisma.messageDelivery.createMany({
        data: deliveries
      });
    }

    // Crear aprobaciones PENDING con los aprobadores activos actuales del canal
    const approvers = await prisma.channelApprover.findMany({
      where: { channelId, isActive: true },
      select: { userId: true }
    });
    if (approvers.length > 0) {
      const approvalsData = approvers.map(a => ({ messageId: message.id, approverId: a.userId, status: 'PENDING', decidedAt: null }));
      // Evitar duplicados si por alguna razón ya existían
      await prisma.messageApproval.createMany({ data: approvalsData, skipDuplicates: true });
    }

    // Devolver el mensaje con relaciones útiles, incluyendo aprobaciones
    const full = await prisma.message.findUnique({
      where: { id: message.id },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } },
        approvals: { include: { approver: { select: { id: true, username: true, fullName: true } } } }
      }
    });

    try {
      if (isEmergency) {
        const host = (process.env.EMITTER_BIND_HOST && process.env.EMITTER_BIND_HOST !== '0.0.0.0') ? process.env.EMITTER_BIND_HOST : 'localhost';
        const port = Number(process.env.EMITTER_HTTP_PORT) || 8766;
        const payload = JSON.stringify({ id: full.id, channelId: full.channelId, content: full.content, createdAt: new Date().toISOString(), eventAt: full.eventAt ? new Date(full.eventAt).toISOString() : undefined });
        const req = http.request({ host, port, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, () => {});
        req.on('error', () => {});
        req.write(payload);
        req.end();
      }
    } catch (e) {}

    res.status(201).json(full);
  } catch (error) {
    console.error('Error creando mensaje:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approverId } = req.body;
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, channelId: true }
    });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const isApprover = await prisma.channelApprover.findUnique({
      where: { channelId_userId: { channelId: msg.channelId, userId: approverId } }
    });
    if (!isApprover) return res.status(403).json({ error: 'No autorizado para aprobar' });
    const rec = await prisma.messageApproval.upsert({
      where: { messageId_approverId: { messageId: id, approverId } },
      update: { status: 'APPROVED', decidedAt: new Date() },
      create: { messageId: id, approverId, status: 'APPROVED', decidedAt: new Date() }
    });
    const msgAfter = await prisma.message.findUnique({ where: { id }, select: { publishedAt: true } });
    if (!msgAfter.publishedAt) {
      await prisma.message.update({ where: { id }, data: { publishedAt: new Date() } });
    }
    res.json(rec);
  } catch (error) {
    res.status(500).json({ error: 'Error aprobando mensaje' });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { approverId } = req.body;
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, channelId: true }
    });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const isApprover = await prisma.channelApprover.findUnique({
      where: { channelId_userId: { channelId: msg.channelId, userId: approverId } }
    });
    if (!isApprover) return res.status(403).json({ error: 'No autorizado para rechazar' });
    const rec = await prisma.messageApproval.upsert({
      where: { messageId_approverId: { messageId: id, approverId } },
      update: { status: 'REJECTED', decidedAt: new Date() },
      create: { messageId: id, approverId, status: 'REJECTED', decidedAt: new Date() }
    });
    res.json(rec);
  } catch (error) {
    res.status(500).json({ error: 'Error rechazando mensaje' });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { requesterId } = req.body;
    const msg = await prisma.message.findUnique({ where: { id }, select: { id: true, senderId: true, expiresAt: true, state: true } });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    if (msg.senderId !== requesterId) return res.status(403).json({ error: 'No autorizado' });
    if (msg.state === 'CANCELLED') return res.status(400).json({ error: 'Mensaje ya cancelado' });
    if (msg.expiresAt && new Date(msg.expiresAt) <= new Date()) return res.status(400).json({ error: 'Mensaje ya vencido' });
    const updated = await prisma.message.update({ where: { id }, data: { state: 'CANCELLED', expiresAt: new Date() } });
    await prisma.messageDelivery.updateMany({ where: { messageId: id, deliveryStatus: 'PENDING' }, data: { deliveryStatus: 'FAILED' } });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error cancelando mensaje' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      editorId,
      content,
      categoryId,
      priority,
      isImmediate,
      deliveryMethod,
      eventAt,
      extra
    } = req.body;

    const existing = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        content: true,
        categoryId: true,
        priority: true,
        isImmediate: true,
        deliveryMethod: true,
        extra: true
      }
    });
    if (!existing) return res.status(404).json({ error: 'Mensaje no encontrado' });

    await prisma.messageRevision.create({
      data: {
        messageId: id,
        editorId,
        previousContent: existing.content,
        previousCategoryId: existing.categoryId,
        previousPriority: existing.priority,
        previousIsImmediate: existing.isImmediate,
        previousDeliveryMethod: existing.deliveryMethod,
        previousExtra: existing.extra
      }
    });

    const updated = await prisma.message.update({
      where: { id },
      data: {
        content: content ?? existing.content,
        categoryId: categoryId ?? existing.categoryId,
        priority: priority ?? existing.priority,
        isImmediate: typeof isImmediate === 'boolean' ? isImmediate : existing.isImmediate,
        deliveryMethod: deliveryMethod ?? existing.deliveryMethod,
        eventAt: eventAt ? new Date(eventAt) : undefined,
        extra: extra ?? existing.extra
      },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } }
      }
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando mensaje' });
  }
});

router.post('/:id/override', async (req, res) => {
  try {
    const { id } = req.params;
    const { policy, setterId } = req.body;
    const setter = await prisma.user.findUnique({
      where: { id: setterId },
      select: { isAdmin: true, isCoordinator: true }
    });
    if (!setter || (!setter.isAdmin && !setter.isCoordinator)) {
      return res.status(403).json({ error: 'No autorizado para override' });
    }
    const updated = await prisma.message.update({
      where: { id },
      data: {
        approvalOverride: policy,
        approvalOverrideSetBy: setterId,
        approvalOverrideSetAt: new Date()
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error aplicando override' });
  }
});

// GET /api/messages/:id/revisions - Historial de ediciones del mensaje
router.get('/:id/revisions', async (req, res) => {
  try {
    const { id } = req.params;
    const exists = await prisma.message.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Mensaje no encontrado' });
    const revisions = await prisma.messageRevision.findMany({
      where: { messageId: id },
      include: { editor: { select: { id: true, username: true, fullName: true } } },
      orderBy: { changedAt: 'desc' }
    });
    res.json(revisions);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo historial de revisiones' });
  }
});

// GET /api/messages/pending/approval - Mensajes pendientes de aprobación
router.get('/pending/approval', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    } catch (e) {
      return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { isAdmin: true }
    });

    if (!user?.isAdmin) {
      return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });
    }

    const messages = await prisma.message.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        },
        publishedAt: null
      },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    res.json(messages);
  } catch (error) {
    console.error('Error obteniendo mensajes pendientes:', error);
    res.status(500).json({ error: 'Error interno del servidor', code: 'PENDING_APPROVAL_FAILED', details: error.message });
  }
});

router.get('/pending/approval/channel/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const skip = (page - 1) * limit;

    const where = { channelId, publishedAt: null };

    const messages = await prisma.message.findMany({
      where,
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { title: true, icon: true } }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    const total = await prisma.message.count({ where });

    res.json({
      messages,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error obteniendo pendientes por canal:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/:id/approvals', async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await prisma.message.findUnique({ where: { id }, select: { channelId: true } });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const activeApprovers = await prisma.channelApprover.findMany({
      where: { channelId: msg.channelId, isActive: true },
      include: { user: { select: { id: true, username: true, fullName: true, avatarUrl: true } } }
    });

    const approvals = await prisma.messageApproval.findMany({
      where: { messageId: id },
      include: { approver: { select: { id: true, username: true, fullName: true, avatarUrl: true } } }
    });

    const activeIds = new Set(activeApprovers.map(a => a.userId));
    const byId = new Map(approvals.map(a => [a.approverId, a]));

    const resultActive = activeApprovers.map(a => ({
      userId: a.userId,
      user: a.user,
      status: byId.get(a.userId)?.status || 'PENDING',
      decidedAt: byId.get(a.userId)?.decidedAt || null,
      removed: false
    }));

    const resultRemoved = approvals
      .filter(a => !activeIds.has(a.approverId))
      .map(a => ({ userId: a.approverId, user: a.approver, status: a.status, decidedAt: a.decidedAt, removed: true }));

    res.json([...resultActive, ...resultRemoved]);
  } catch (error) {
    console.error('Error obteniendo aprobaciones del mensaje:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Registrar vista de mensaje
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    let actorId = null;
    if (token) { try { const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); actorId = payload.sub; } catch {} }

    const msg = await prisma.message.findUnique({ where: { id }, select: { id: true } });
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

    await prisma.messageView.create({ data: { messageId: id, userId: actorId } });
    if (actorId) await prisma.auditLog.create({ data: { actorId, action: 'MESSAGE_VIEW', details: { messageId: id } } });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error registrando vista' });
  }
});

// Resumen de vistas de mensaje
router.get('/:id/views', async (req, res) => {
  try {
    const { id } = req.params;
    const total = await prisma.messageView.count({ where: { messageId: id } });
    const distinct = await prisma.messageView.findMany({ where: { messageId: id, userId: { not: null } }, distinct: ['userId'], select: { userId: true } });
    const viewers = await prisma.$queryRaw`SELECT u.id, u.username, u.full_name as "fullName", COUNT(mv.id) as count FROM tify_message_views mv LEFT JOIN tify_users u ON mv.user_id = u.id WHERE mv.message_id = ${id} GROUP BY u.id, u.username, u.full_name ORDER BY count DESC LIMIT 20`;
    res.json({ total, uniqueViewers: distinct.length, viewers });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo vistas' });
  }
});

module.exports = router;