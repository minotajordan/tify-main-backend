const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// GET /api/channels - Obtener todos los canales
router.get('/', async (req, res) => {
  try {
    const { userId, search, isPublic } = req.query;
    
    const where = {};
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { description: { contains: search } }
      ];
    }
    if (isPublic !== undefined) {
      where.isPublic = isPublic === 'true';
    }
    
    // Si no hay búsqueda específica, solo retornar canales raíz (sin padre)
    // para evitar duplicidad y reducir carga.
    if (!search) {
        where.parentId = null;
    }

    const channels = await prisma.channel.findMany({
      where,
      include: {
        owner: {
          select: { id: true, username: true, fullName: true }
        },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { id: true, content: true, createdAt: true, priority: true }
        },
        subchannels: {
          select: {
            messages: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { id: true, content: true, createdAt: true, priority: true }
            }
          }
        },
        subscriptions: userId ? {
          where: { userId },
          select: { isActive: true }
        } : false,
        _count: {
          select: { subscriptions: true, messages: true, subchannels: true }
        }
      },
      orderBy: { memberCount: 'desc' }
    });

    const channelsWithSubscription = channels.map(channel => {
      // Find the absolute latest message among the channel and its subchannels
      const directMsg = channel.messages?.[0];
      const subMsgCandidates = channel.subchannels?.flatMap(s => s.messages) || [];
      const allMessages = [directMsg, ...subMsgCandidates].filter(Boolean);
      
      // Sort desc by createdAt
      allMessages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const lastMsg = allMessages[0];

      return {
        ...channel,
        lastMessageId: lastMsg ? lastMsg.id : null,
        lastMessagePreview: lastMsg ? String(lastMsg.content).slice(0, 140) : null,
        lastMessageAt: lastMsg ? lastMsg.createdAt : null,
        lastMessagePriority: lastMsg ? lastMsg.priority : null,
        subchannelsCount: channel._count?.subchannels || 0,
        isSubscribed: userId ? channel.subscriptions?.length > 0 : false,
        subscriptions: undefined,
        messages: undefined,
        subchannels: undefined // Ensure subchannels list is not returned
      };
    });

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.json(channelsWithSubscription);
  } catch (error) {
    console.error('Error obteniendo canales:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PRIORIDAD: Ruta de búsqueda antes de rutas parametrizadas
router.get('/search', async (req, res) => {
  try {
    const { q = '', exact = 'false', referenceCode, page = '1', limit = '12' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * pageSize;

    if (referenceCode) {
      const refCodeParam = String(referenceCode).startsWith('REF-') ? String(referenceCode) : `REF-${referenceCode}`;
      const byCode = await prisma.channel.findUnique({
        where: { referenceCode: refCodeParam },
        include: { owner: { select: { id: true, username: true, fullName: true } } }
      });
      return res.json(byCode ? [byCode] : []);
    }

    const query = String(q).trim();
    if (!query) return res.json([]);

    const refPattern = /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/;
    if (refPattern.test(query)) {
      const refCode = `REF-${query}`;
      const byCode = await prisma.channel.findUnique({
        where: { referenceCode: refCode },
        include: { owner: { select: { id: true, username: true, fullName: true } } }
      });
      return res.json(byCode ? [byCode] : []);
    }

    if (exact === 'true') {
      const channels = await prisma.channel.findMany({
        where: { title: query },
        include: { owner: { select: { id: true, username: true, fullName: true } } },
        orderBy: { memberCount: 'desc' },
        skip,
        take: pageSize
      });
      return res.json(channels);
    }

    const channels = await prisma.channel.findMany({
      where: {
        isHidden: false,
        title: { contains: query },
        NOT: { searchExactOnly: true }
      },
      include: { owner: { select: { id: true, username: true, fullName: true } } },
      orderBy: { memberCount: 'desc' },
      skip,
      take: pageSize
    });
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: 'Error buscando canales' });
  }
});

// GET /api/channels/:id - Obtener canal específico
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const channel = await prisma.channel.findUnique({
      where: { id },
      include: {
        owner: {
          select: { id: true, username: true, fullName: true }
        },
        subchannels: true,
        messages: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            sender: { select: { id: true, username: true, fullName: true } },
            _count: { select: { views: true } }
          }
        },
        approvers: {
          include: {
            user: { select: { id: true, username: true, fullName: true } }
          }
        },
        subscriptions: userId ? {
          where: { userId },
          select: { isActive: true }
        } : false
      }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Canal no encontrado' });
    }

    let channelWithSubscription = {
      ...channel,
      isSubscribed: userId ? channel.subscriptions?.length > 0 : false,
      subscriptions: undefined
    };

    if (userId && channelWithSubscription.messages?.length) {
      const ids = channelWithSubscription.messages.map(m => m.id);
      const seen = await prisma.messageView.findMany({ where: { messageId: { in: ids }, userId }, select: { messageId: true } });
      const seenSet = new Set(seen.map(s => s.messageId));
      channelWithSubscription = {
        ...channelWithSubscription,
        messages: channelWithSubscription.messages.map(m => ({ ...m, viewsCount: m._count?.views || 0, viewedByMe: seenSet.has(m.id) }))
      };
    }

    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=120');
    res.json(channelWithSubscription);
  } catch (error) {
    console.error('Error obteniendo canal:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PATCH /api/channels/:id - Actualizar detalles del canal
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, 
      description, 
      icon, 
      logoUrl, 
      coverUrl, 
      websiteUrl, 
      socialLinks, 
      approvalPolicy, 
      isPublic, 
      isHidden,
      searchExactOnly,
      ownerId
    } = req.body;

    let ownerUpdate = {};
    if (ownerId !== undefined) {
      if (ownerId === null) {
        ownerUpdate = { ownerId: null };
      } else {
        const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
        if (!owner) return res.status(404).json({ error: 'Propietario no encontrado' });
        ownerUpdate = { ownerId };
      }
    }

    const updatedChannel = await prisma.channel.update({
      where: { id },
      data: {
        title,
        description,
        icon,
        logoUrl,
        coverUrl,
        websiteUrl,
        socialLinks,
        approvalPolicy,
        isPublic,
        isHidden,
        searchExactOnly,
        ...ownerUpdate
      }
    });

    res.json(updatedChannel);
  } catch (error) {
    console.error('Error actualizando canal:', error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

// GET /api/channels/:id/subchannels - Subcanales paginados con conteos
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const { range = 'all' } = req.query;
    let start = null;
    if (range === '1h') start = new Date(Date.now() - 60 * 60 * 1000);
    else if (range === '24h') start = new Date(Date.now() - 24 * 60 * 60 * 1000);
    else if (range === '7d') start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    else if (range === '1m') start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const subs = await prisma.channel.findMany({ where: { parentId: id }, select: { id: true } });
    const ids = [id, ...subs.map(s => s.id)];

    const deliveredWhere = { message: { channelId: { in: ids } }, deliveryStatus: 'DELIVERED' };
    if (start) deliveredWhere.deliveredAt = { gte: start };
    const readWhere = { message: { channelId: { in: ids } }, readAt: { not: null } };
    if (start) readWhere.readAt = { gte: start };
    const unreadWhere = { message: { channelId: { in: ids } }, deliveryStatus: 'DELIVERED', readAt: null };
    if (start) unreadWhere.deliveredAt = { gte: start };

    const subscribersWhere = start
      ? { channelId: { in: ids }, subscribedAt: { gte: start }, isActive: true }
      : { channelId: { in: ids }, isActive: true };

    const [delivered, read, unread, subscribers] = await Promise.all([
      prisma.messageDelivery.count({ where: deliveredWhere }),
      prisma.messageDelivery.count({ where: readWhere }),
      prisma.messageDelivery.count({ where: unreadWhere }),
      prisma.channelSubscription.count({ where: subscribersWhere })
    ]);

    const approverUsers = await prisma.channelApprover.findMany({
      where: start ? { channelId: { in: ids }, createdAt: { gte: start } } : { channelId: { in: ids } },
      select: { userId: true }
    });
    const approvers = new Set(approverUsers.map(a => a.userId)).size;

    res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
    res.json({ delivered, read, unread, subscribers, approvers });
  } catch (error) {
    console.error('Error obteniendo estadísticas de canal:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/:id/subchannels', async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.channel.findMany({
        where: { parentId: id },
        select: { id: true, title: true, icon: true, memberCount: true },
        orderBy: { memberCount: 'desc' },
        skip,
        take: limit
      }),
      prisma.channel.count({ where: { parentId: id } })
    ]);

    if (items.length === 0) {
      return res.json({
        items: [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      });
    }

    const channelIds = items.map(c => c.id);

    // Optimized aggregation queries to avoid N+1 problem and connection pool exhaustion
    const [approversCounts, pendingCounts, sentCounts, subsCounts] = await Promise.all([
      prisma.channelApprover.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds } },
        _count: { id: true }
      }),
      prisma.message.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, publishedAt: null },
        _count: { id: true }
      }),
      prisma.message.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, NOT: { publishedAt: null } },
        _count: { id: true }
      }),
      prisma.channelSubscription.groupBy({
        by: ['channelId'],
        where: { channelId: { in: channelIds }, isActive: true },
        _count: { id: true }
      })
    ]);

    const getCount = (arr, channelId) => {
      const found = arr.find(x => x.channelId === channelId);
      return found ? found._count.id : 0;
    };

    const augmented = items.map(sc => {
      const approversCount = getCount(approversCounts, sc.id);
      const pendingCount = getCount(pendingCounts, sc.id);
      const sentCount = getCount(sentCounts, sc.id);
      const subsCount = getCount(subsCounts, sc.id);

      return { 
        ...sc, 
        memberCount: subsCount, 
        counts: { 
          approvers: approversCount, 
          pending: pendingCount, 
          sent: sentCount 
        } 
      };
    });

    res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');
    res.json({
      items: augmented,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('Error obteniendo subcanales:', error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

// GET /api/channels/:id/subscriptions - Usuarios inscritos al subcanal (búsqueda y paginación)
router.get('/:id/subscriptions', async (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '20');
    const q = (req.query.q || '').toString();
    const skip = (page - 1) * limit;

    const baseWhere = { channelId: id, isActive: true };
    const where = q ? {
      ...baseWhere,
      user: {
        is: {
          OR: [
            { fullName: { contains: q } },
            { username: { contains: q } },
            { email: { contains: q } },
            { phoneNumber: { contains: q } }
          ]
        }
      }
    } : baseWhere;

    const [items, total] = await Promise.all([
      prisma.channelSubscription.findMany({
        where,
        include: { user: { select: { id: true, email: true, username: true, fullName: true, phoneNumber: true, avatarUrl: true, isPhoneVerified: true } } },
        orderBy: { subscribedAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.channelSubscription.count({ where })
    ]);

    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
    res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('Error listando suscriptores:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/channels/user/:userId/subscribed - Canales suscritos del usuario
router.get('/user/:userId/subscribed', async (req, res) => {
  try {
    const { userId } = req.params;

    const subscriptions = await prisma.channelSubscription.findMany({
      where: { 
        userId,
        isActive: true 
      },
      include: {
        channel: {
          include: {
            owner: {
              select: { id: true, username: true, fullName: true }
            },
            subchannels: {
              select: { id: true, title: true, icon: true }
            }
          }
        }
      }
    });

    const channels = subscriptions.map(sub => ({
      ...sub.channel,
      isSubscribed: true,
      subscribedAt: sub.subscribedAt
    }));

    res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=300');
    res.json(channels);
  } catch (error) {
    console.error('Error obteniendo canales suscritos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/channels/:id/validate-password - Validar contraseña de canal privado
router.post('/:id/validate-password', async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    const channel = await prisma.channel.findUnique({
      where: { id },
      select: { passwordHash: true, isPublic: true }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Canal no encontrado' });
    }

    if (channel.isPublic) {
      return res.json({ valid: true });
    }

    // Simulación de validación de contraseña (en producción usar bcrypt)
    const bcrypt = require('bcryptjs');
    const isValid = await bcrypt.compare(password, channel.passwordHash);

    res.json({ valid: isValid });
  } catch (error) {
    console.error('Error validando contraseña:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      icon,
      parentId,
      ownerId,
      organizationId,
      isPublic = true,
      isHidden = false,
      searchExactOnly = false,
      password,
      referenceCode,
      approvalPolicy = 'OPTIONAL',
      websiteUrl,
      socialLinks,
      logoUrl,
      coverUrl
    } = req.body;

    const { organizationName, nit } = req.body || {};
    if (!title || !ownerId || (!organizationId && !(organizationName && nit))) {
      return res.status(400).json({ error: 'Campos requeridos: title, ownerId y organizationId o organizationName+nit', code: 'VALIDATION_ERROR' });
    }

    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) return res.status(404).json({ error: 'Propietario no encontrado', code: 'OWNER_NOT_FOUND' });
    let orgId = organizationId;
    let org = null;
    if (orgId) {
      org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!org && organizationName && nit) {
        org = await prisma.organization.create({ data: { name: organizationName, nit } });
        orgId = org.id;
      }
      if (!org) return res.status(404).json({ error: 'Organización no encontrada', code: 'ORGANIZATION_NOT_FOUND' });
    } else {
      org = await prisma.organization.create({ data: { name: organizationName, nit } });
      orgId = org.id;
    }

    let passwordHash = null;
    if (!isPublic && password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const code = referenceCode || Math.random().toString(36).slice(2, 10).toUpperCase();

    const channel = await prisma.channel.create({
      data: {
        title,
        description,
        websiteUrl: websiteUrl || null,
        socialLinks: socialLinks || null,
        logoUrl: logoUrl || null,
        coverUrl: coverUrl || null,
        icon: icon || 'bubble.left.and.bubble.right',
        parentId: parentId || null,
        ownerId,
        organizationId: orgId,
        isPublic,
        isHidden,
        searchExactOnly,
        passwordHash,
        referenceCode: code,
        approvalPolicy
      }
    });

    res.status(201).json(channel);
  } catch (error) {
    res.status(500).json({ error: 'Error creando canal', code: 'CHANNEL_CREATE_FAILED', details: error.message });
  }
});

router.post('/:id/subchannels', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      icon,
      ownerId,
      organizationId,
      isPublic = true,
      isHidden = false,
      searchExactOnly = false,
      password,
      referenceCode,
      approvalPolicy = 'OPTIONAL',
      websiteUrl,
      socialLinks,
      logoUrl,
      coverUrl
    } = req.body;

    const { organizationName, nit } = req.body || {};
    if (!title || !ownerId || (!organizationId && !(organizationName && nit))) {
      return res.status(400).json({ error: 'Campos requeridos: title, ownerId y organizationId o organizationName+nit', code: 'VALIDATION_ERROR' });
    }

    const parent = await prisma.channel.findUnique({ where: { id }, select: { id: true } });
    if (!parent) return res.status(404).json({ error: 'Canal padre no encontrado', code: 'PARENT_NOT_FOUND' });
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!owner) return res.status(404).json({ error: 'Propietario no encontrado', code: 'OWNER_NOT_FOUND' });
    let orgId = organizationId;
    let org = null;
    if (orgId) {
      org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
      if (!org && organizationName && nit) {
        org = await prisma.organization.create({ data: { name: organizationName, nit } });
        orgId = org.id;
      }
      if (!org) return res.status(404).json({ error: 'Organización no encontrada', code: 'ORGANIZATION_NOT_FOUND' });
    } else {
      org = await prisma.organization.create({ data: { name: organizationName, nit } });
      orgId = org.id;
    }

    let passwordHash = null;
    if (!isPublic && password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const code = referenceCode || Math.random().toString(36).slice(2, 10).toUpperCase();

    const channel = await prisma.channel.create({
      data: {
        title,
        description,
        websiteUrl: websiteUrl || null,
        socialLinks: socialLinks || null,
        logoUrl: logoUrl || null,
        coverUrl: coverUrl || null,
        icon: icon || 'bubble.left.and.bubble.right',
        parentId: id,
        ownerId,
        organizationId: orgId,
        isPublic,
        isHidden,
        searchExactOnly,
        passwordHash,
        referenceCode: code,
        approvalPolicy
      }
    });

    res.status(201).json(channel);
  } catch (error) {
    res.status(500).json({ error: 'Error creando subcanal', code: 'SUBCHANNEL_CREATE_FAILED', details: error.message });
  }
});



router.post('/:id/approvers', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }

    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    const channel = await prisma.channel.findUnique({ where: { id }, select: { ownerId: true } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
    if (!requester?.isAdmin && channel.ownerId !== payload.sub) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const exists = await prisma.channelApprover.findUnique({ where: { channelId_userId: { channelId: id, userId } } });
    if (exists) {
      if (exists.isActive) return res.status(409).json({ error: 'Aprobador ya asignado' });
      const revived = await prisma.channelApprover.update({ where: { id: exists.id }, data: { isActive: true, removedAt: null, removedBy: null } });
      return res.status(200).json(revived);
    }

    const sub = await prisma.channelSubscription.findUnique({ where: { userId_channelId: { userId, channelId: id } } });
    if (!sub || !sub.isActive) return res.status(400).json({ error: 'El usuario debe estar inscrito al canal' });

    const approver = await prisma.channelApprover.create({ data: { channelId: id, userId } });
    res.status(201).json(approver);
  } catch (error) {
    res.status(500).json({ error: 'Error asignando aprobador' });
  }
});

router.delete('/:id/approvers/:userId', async (req, res) => {
  try {
    const { id, userId } = req.params;

    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload; try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }

    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    const channel = await prisma.channel.findUnique({ where: { id }, select: { ownerId: true } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
    if (!requester?.isAdmin && channel.ownerId !== payload.sub) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const record = await prisma.channelApprover.findUnique({ where: { channelId_userId: { channelId: id, userId } } });
    if (!record) return res.status(404).json({ error: 'Aprobador no encontrado' });
    if (!record.isActive) return res.status(200).json({ message: 'Ya estaba inactivo' });
    const updated = await prisma.channelApprover.update({ where: { id: record.id }, data: { isActive: false, removedAt: new Date(), removedBy: payload.sub } });
    res.json({ message: 'Aprobador desactivado', data: updated });
  } catch (error) {
    res.status(500).json({ error: 'Error eliminando aprobador' });
  }
});

// GET /api/channels/:id/approver-history - Historial de aprobadores (activo e inactivos)
router.get('/:id/approver-history', async (req, res) => {
  try {
    const { id } = req.params;
    const items = await prisma.channelApprover.findMany({
      where: { channelId: id },
      include: {
        user: { select: { id: true, username: true, fullName: true, avatarUrl: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    let removedByUsers = {};
    const ids = Array.from(new Set(items.map(i => i.removedBy).filter(Boolean)));
    if (ids.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, fullName: true } });
      removedByUsers = Object.fromEntries(users.map(u => [u.id, u]));
    }
    const result = items.map(i => ({
      userId: i.userId,
      user: i.user,
      isActive: i.isActive,
      assignedAt: i.createdAt,
      removedAt: i.removedAt,
      removedBy: i.removedBy ? removedByUsers[i.removedBy] || { id: i.removedBy } : null,
      durationDays: i.removedAt ? Math.max(0, Math.round((i.removedAt - i.createdAt) / (1000*60*60*24))) : null
    }));
    res.json(result);
  } catch (error) {
    console.error('Error obteniendo historial de aprobadores:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/:id/verification-docs', async (req, res) => {
  try {
    const { id } = req.params;
    const docs = await prisma.channelVerificationDocument.findMany({
      where: { channelId: id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: 'Error listando documentos' });
  }
});

router.post('/:id/verification-docs', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, docUrl, issuer, issuedAt } = req.body;
    const doc = await prisma.channelVerificationDocument.create({
      data: { channelId: id, title, docUrl, issuer: issuer || null, issuedAt: issuedAt || null }
    });
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ error: 'Error creando documento' });
  }
});

router.post('/:id/categories', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    let category = await prisma.channelCategory.findUnique({ where: { name } });
    if (!category) {
      category = await prisma.channelCategory.create({ data: { name, description: description || null } });
    }
    const assignment = await prisma.channelCategoryAssignment.create({
      data: { channelId: id, categoryId: category.id }
    });
    res.status(201).json(assignment);
  } catch (error) {
    res.status(500).json({ error: 'Error asignando categoría' });
  }
});

// Registrar visita de canal
router.post('/:id/visit', async (req, res) => {
  try {
    const { id } = req.params;
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    let actorId = null;
    if (token) { try { const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); actorId = payload.sub; } catch {} }

    const ch = await prisma.channel.findUnique({ where: { id }, select: { id: true } });
    if (!ch) return res.status(404).json({ error: 'Canal no encontrado' });

    await prisma.channelVisit.create({ data: { channelId: id, userId: actorId } });
    if (actorId) await prisma.auditLog.create({ data: { actorId, action: 'CHANNEL_VISIT', targetChannelId: id, details: {} } });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error registrando visita' });
  }
});

// Resumen de visitas de canal
router.get('/:id/visits', async (req, res) => {
  try {
    const { id } = req.params;
    const total = await prisma.channelVisit.count({ where: { channelId: id } });
    const distinct = await prisma.channelVisit.findMany({ where: { channelId: id, userId: { not: null } }, distinct: ['userId'], select: { userId: true } });
    res.json({ total, uniqueVisitors: distinct.length });
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo visitas' });
  }
});

module.exports = router;
