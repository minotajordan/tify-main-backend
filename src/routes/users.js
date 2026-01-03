const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const jwt = require('jsonwebtoken');
// GET /api/users - Listar usuarios con métricas
router.get('/', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        phoneNumber: true,
        isAdmin: true,
        isDisabled: true,
        createdAt: true,
        _count: {
          select: {
            subscriptions: true,
            messagesSent: true,
            ownedChannels: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const result = users.map(u => ({
      ...u,
      subscribedChannelsCount: u._count.subscriptions,
      messagesCount: u._count.messagesSent,
      ownedChannelsCount: u._count.ownedChannels,
      _count: undefined
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error listando usuarios', code: 'USERS_LIST_FAILED', details: error.message });
  }
});

// GET /api/users/paged - Lista paginada con búsqueda
router.get('/paged', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const q = (req.query.q || '').toString();
    const skip = (page - 1) * limit;

    const where = q ? {
      OR: [
        { email: { contains: q } },
        { username: { contains: q } },
        { fullName: { contains: q } }
      ]
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          phoneNumber: true,
          isAdmin: true,
          isDisabled: true,
          createdAt: true,
          avatarUrl: true,
          _count: { select: { subscriptions: true, messagesSent: true, ownedChannels: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.user.count({ where })
    ]);

    const items = await Promise.all(users.map(async (u) => {
      const activeSubs = await prisma.channelSubscription.count({ where: { userId: u.id, isActive: true } });
      return {
        ...u,
        subscribedChannelsCount: activeSubs,
        messagesCount: u._count.messagesSent,
        ownedChannelsCount: u._count.ownedChannels,
        _count: undefined
      };
    }));

    res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: 'Error listando usuarios', code: 'USERS_LIST_PAGED_FAILED', details: error.message });
  }
});

// GET /api/users/:id - Obtener perfil de usuario
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        avatarUrl: true,
        phoneNumber: true,
        isGuest: true,
        isPhoneVerified: true,
        isAdmin: true,
        isDisabled: true,
        createdAt: true,
        verificationCode: true,
        profile: { select: { extra: true } },
        _count: {
          select: {
            subscriptions: true,
            messagesSent: true,
            ownedChannels: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const activeSubs = await prisma.channelSubscription.count({ where: { userId: id, isActive: true } });
    const stats = {
      subscribedChannelsCount: activeSubs,
      messagesCount: user._count.messagesSent,
      ownedChannelsCount: user._count.ownedChannels,
      pendingApprovalsCount: user.isAdmin ? 3 : 0
    };

    const userProfile = {
      ...user,
      bio: user.profile?.extra?.bio || null,
      ...stats,
      _count: undefined,
      profile: undefined
    };

    res.json(userProfile);
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PATCH /api/users/:id - Actualizar perfil de usuario
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, phoneNumber, username, email, avatarUrl, bio } = req.body;

    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (username !== undefined) updateData.username = username;
    if (email !== undefined) updateData.email = email;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

    try {
      const user = await prisma.user.update({
        where: { id },
        data: updateData,
        include: { profile: true }
      });

      if (bio !== undefined) {
        const extra = user.profile?.extra ? JSON.parse(JSON.stringify(user.profile.extra)) : {};
        extra.bio = bio;

        if (user.profile) {
          await prisma.userProfile.update({
            where: { userId: id },
            data: { extra }
          });
        } else {
          await prisma.userProfile.create({
            data: { userId: id, extra }
          });
        }
      }

      // Return updated user without sensitive fields
      const { passwordHash, ...safeUser } = user;
      res.json(safeUser);
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(400).json({ error: 'El nombre de usuario o correo ya está en uso', code: 'DUPLICATE_ENTRY' });
      }
      throw e;
    }
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

// GET /api/users/:id/channels/owned - Canales que administra el usuario
router.get('/:id/channels/owned', async (req, res) => {
  try {
    const { id } = req.params;

    const channels = await prisma.channel.findMany({
      where: { ownerId: id },
      include: {
        _count: {
          select: {
            messages: true,
            subscriptions: {
              where: { isActive: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(channels);
  } catch (error) {
    console.error('Error obteniendo canales del usuario:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/users/:id/subscriptions - Suscripciones del usuario
router.get('/:id/subscriptions', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const subs = await prisma.channelSubscription.findMany({
      where: { userId: id, isActive: true },
      include: { channel: { select: { id: true, title: true, icon: true, logoUrl: true } } },
      orderBy: { subscribedAt: 'desc' }
    });
    res.json(subs);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo suscripciones', code: 'USER_SUBSCRIPTIONS_FAILED', details: error.message });
  }
});

// GET /api/users/:id/approver-assignments - Canales donde es aprobador
router.get('/:id/approver-assignments', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const approvers = await prisma.channelApprover.findMany({
      where: { userId: id, isActive: true },
      include: { channel: { select: { id: true, title: true, icon: true, parentId: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(approvers);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo asignaciones de aprobador', code: 'USER_APPROVERS_FAILED', details: error.message });
  }
});

// GET /api/users/:id/pending-approvals - Mensajes pendientes para aprobar
router.get('/:id/pending-approvals', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const hours = Number(req.query.windowHours || 24);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const messages = await prisma.message.findMany({
      where: {
        createdAt: { gte: since },
        channel: { approvers: { some: { userId: id, isActive: true } } }
      },
      include: {
        sender: { select: { id: true, username: true, fullName: true } },
        channel: { select: { id: true, title: true, icon: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo pendientes de aprobación', code: 'USER_PENDING_APPROVALS_FAILED', details: error.message });
  }
});

// GET /api/users/:id/stats - Estadísticas del usuario
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { isAdmin: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Obtener estadísticas
    const [
      subscribedChannels,
      sentMessages,
      ownedChannels,
      recentActivity
    ] = await Promise.all([
      prisma.channelSubscription.count({
        where: { userId: id, isActive: true }
      }),
      prisma.message.count({
        where: { senderId: id }
      }),
      prisma.channel.count({
        where: { ownerId: id }
      }),
      prisma.message.findMany({
        where: { senderId: id },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          channel: {
            select: { title: true, icon: true }
          }
        }
      })
    ]);

    const stats = {
      subscribedChannelsCount: subscribedChannels,
      messagesCount: sentMessages,
      ownedChannelsCount: ownedChannels,
      pendingApprovalsCount: user.isAdmin ? 3 : 0, // Simulado
      recentActivity
    };

    res.json(stats);
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/users/:id/activity - Actividad por rango
router.get('/:id/activity', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const range = String(req.query.range || '24h');
    const ranges = { '1h': 1, '24h': 24, '7d': 7 * 24, '1m': 30 * 24 };
    const hours = ranges[range] || 24;
    const since = range === 'all' ? null : new Date(Date.now() - hours * 60 * 60 * 1000);

    const whereMsg = since ? { senderId: id, createdAt: { gte: since } } : { senderId: id };
    const whereDel = since ? { userId: id, createdAt: { gte: since } } : { userId: id };

    const [sentInRange, deliveriesInRange, read, unread] = await Promise.all([
      prisma.message.count({ where: whereMsg }),
      prisma.messageDelivery.count({ where: whereDel }),
      prisma.messageDelivery.count({ where: { ...whereDel, readAt: { not: null } } }),
      prisma.messageDelivery.count({ where: { ...whereDel, deliveredAt: { not: null }, readAt: null } })
    ]);

    res.json({ sentInRange, deliveriesInRange, read, unread });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo actividad', code: 'USER_ACTIVITY_FAILED', details: error.message });
  }
});

// GET /api/users/:id/top-channels - Top canales por mensajes enviados
router.get('/:id/top-channels', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const range = String(req.query.range || '24h');
    const ranges = { '1h': 1, '24h': 24, '7d': 7 * 24, '1m': 30 * 24 };
    const hours = ranges[range] || 24;
    const since = range === 'all' ? null : new Date(Date.now() - hours * 60 * 60 * 1000);
    const where = since ? { senderId: id, createdAt: { gte: since } } : { senderId: id };

    const msgs = await prisma.message.findMany({ where, select: { channelId: true } });
    const counts = new Map();
    for (const m of msgs) counts.set(m.channelId, (counts.get(m.channelId) || 0) + 1);
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const channelIds = sorted.map(([cid]) => cid);
    const channels = await prisma.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, title: true, icon: true, logoUrl: true } });
    const items = sorted.map(([cid, count]) => ({ channel: channels.find(c => c.id === cid), count }));
    res.json({ items });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo top canales', code: 'USER_TOP_CHANNELS_FAILED', details: error.message });
  }
});

// GET /api/users/:id/audit-logs - Auditoría de acciones (solo admin)
router.get('/:id/audit-logs', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const skip = (page - 1) * limit;

    const where = { OR: [{ targetUserId: id }, { actorId: id }] };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.auditLog.count({ where })
    ]);

    res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo auditoría', code: 'USER_AUDIT_FAILED', details: error.message });
  }
});

// POST /api/users - Crear usuario (admin)
router.post('/', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { email, username, fullName, phoneNumber, avatarUrl, isAdmin = false, password } = req.body;
    if (!email || !username) return res.status(400).json({ error: 'email y username son requeridos', code: 'VALIDATION_ERROR' });

    const bcrypt = require('bcryptjs');
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;

    const created = await prisma.user.create({
      data: {
        email,
        username,
        fullName: fullName || username,
        phoneNumber: phoneNumber || null,
        avatarUrl: avatarUrl || null,
        isAdmin: !!isAdmin,
        isGuest: false,
        passwordHash
      },
      select: { id: true, email: true, username: true, fullName: true, phoneNumber: true, isAdmin: true, avatarUrl: true, createdAt: true }
    });

    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: 'Error creando usuario', code: 'USER_CREATE_FAILED', details: error.message });
  }
});

module.exports = router;
router.post('/:id/messaging-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const { platform, handle } = req.body;
    const setting = await prisma.userMessagingSetting.upsert({
      where: { userId_platform: { userId: id, platform } },
      update: { handle: handle || null },
      create: { userId: id, platform, handle: handle || null }
    });
    res.status(201).json(setting);
  } catch (error) {
    res.status(500).json({ error: 'Error configurando plataforma' });
  }
});

router.put('/:id/messaging-settings/:platform', async (req, res) => {
  try {
    const { id, platform } = req.params;
    const { handle, verified } = req.body;
    const setting = await prisma.userMessagingSetting.update({
      where: { userId_platform: { userId: id, platform } },
      data: { handle: handle || null, verified }
    });
    res.json(setting);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando plataforma' });
  }
});

// PATCH /api/users/:id/disable
router.patch('/:id/disable', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const updated = await prisma.user.update({ where: { id }, data: { isDisabled: true }, select: { id: true, isDisabled: true } });
    await prisma.auditLog.create({ data: { actorId: payload.sub, action: 'USER_DISABLE', targetUserId: id, details: {} } });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error deshabilitando usuario', code: 'USER_DISABLE_FAILED', details: error.message });
  }
});

// PATCH /api/users/:id/enable
router.patch('/:id/enable', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    const updated = await prisma.user.update({ where: { id }, data: { isDisabled: false }, select: { id: true, isDisabled: true } });
    await prisma.auditLog.create({ data: { actorId: payload.sub, action: 'USER_ENABLE', targetUserId: id, details: {} } });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error habilitando usuario', code: 'USER_ENABLE_FAILED', details: error.message });
  }
});

// DELETE /api/users/:id - Eliminar usuario y sus relaciones
router.delete('/:id', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { id } = req.params;
    await prisma.messageApproval.deleteMany({ where: { approverId: id } });
    await prisma.messageRevision.deleteMany({ where: { editorId: id } });
    const deleted = await prisma.user.delete({ where: { id } });
    await prisma.auditLog.create({ data: { actorId: payload.sub, action: 'USER_DELETE', targetUserId: id, details: {} } });
    res.json({ deleted: { id: deleted.id } });
  } catch (error) {
    res.status(500).json({ error: 'Error eliminando usuario', code: 'USER_DELETE_FAILED', details: error.message });
  }
});

router.post('/:id/request-verification-code', async (req, res) => {
  try {
    const { id } = req.params;
    const { phoneNumber, username, fullName, avatarUrl } = req.body || {};
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    const updated = await prisma.user.update({
      where: { id },
      data: {
        verificationCode: code,
        verificationCodeExpiresAt: expires,
        phoneNumber: phoneNumber || undefined,
        username: username || undefined,
        fullName: fullName || undefined,
        avatarUrl: avatarUrl || undefined
      },
      select: { id: true, verificationCode: true, verificationCodeExpiresAt: true }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error generando código', code: 'CODE_GEN_FAILED', details: error.message });
  }
});

router.post('/:id/register', async (req, res) => {
  try {
    const { id } = req.params;
    const { phoneNumber, username, fullName, avatarUrl, code, email } = req.body;
    const user = await prisma.user.findUnique({ where: { id }, select: { verificationCode: true, verificationCodeExpiresAt: true } });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
    if (!user.verificationCode || code !== user.verificationCode) return res.status(403).json({ error: 'Código inválido', code: 'INVALID_CODE' });
    if (user.verificationCodeExpiresAt && user.verificationCodeExpiresAt < new Date()) return res.status(403).json({ error: 'Código expirado', code: 'CODE_EXPIRED' });

    const updated = await prisma.user.update({
      where: { id },
      data: {
        phoneNumber: phoneNumber || undefined,
        username: username || undefined,
        fullName: fullName || undefined,
        avatarUrl: avatarUrl || undefined,
        email: email || undefined,
        isPhoneVerified: true,
        isGuest: false,
        verificationCode: null,
        verificationCodeExpiresAt: null
      },
      select: { id: true, email: true, username: true, fullName: true, avatarUrl: true, phoneNumber: true, isPhoneVerified: true, isGuest: true }
    });
    const token = jwt.sign({ sub: updated.id, isAdmin: false }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '30d' });
    res.json({ user: updated, token });
  } catch (error) {
    res.status(500).json({ error: 'Error registrando usuario', code: 'USER_REGISTER_FAILED', details: error.message });
  }
});

router.post('/guest', async (req, res) => {
  try {
    const { deviceId, fullName } = req.body;
    let user = await prisma.user.findUnique({ where: { deviceId }, select: { id: true } });
    if (!user) {
      const email = `${deviceId}@tify.pro`;
      user = await prisma.user.create({
        data: {
          deviceId,
          email,
          username: `guest_${Math.random().toString(36).slice(2,6)}`,
          fullName: fullName || null,
          avatarUrl: null,
          isGuest: true,
          isPhoneVerified: false
        }
      });
    }
    res.status(201).json({ id: user.id });
  } catch (error) {
    res.status(500).json({ error: 'Error creando invitado', code: 'GUEST_CREATE_FAILED', details: error.message });
  }
});