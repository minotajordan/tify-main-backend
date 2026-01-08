const express = require('express');
const router = express.Router();
const prisma = require('../config/database');

// POST /api/subscriptions - Suscribirse a un canal
router.post('/', async (req, res) => {
  try {
    const { userId, channelId, subchannelIds = [] } = req.body;

    // Verificar si ya está suscrito
    const existingSubscription = await prisma.channelSubscription.findUnique({
      where: {
        userId_channelId: {
          userId,
          channelId
        }
      }
    });

    if (existingSubscription) {
      // Reactivar suscripción si estaba inactiva
      const subscription = await prisma.channelSubscription.update({
        where: { id: existingSubscription.id },
        data: { isActive: true }
      });

      return res.json({ 
        message: 'Suscripción reactivada',
        subscription 
      });
    }

    // Crear nueva suscripción
    const subscription = await prisma.channelSubscription.create({
      data: {
        userId,
        channelId,
        isActive: true
      },
      include: {
        channel: {
          select: { title: true, icon: true }
        }
      }
    });

    // Incrementar contador de miembros
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        memberCount: {
          increment: 1
        }
      }
    });

    // TODO: Suscribirse a subcanales específicos
    // Esto requeriría una tabla adicional para manejar suscripciones granulares

    await prisma.auditLog.create({ data: { actorId: userId, action: 'USER_SUBSCRIBE', targetUserId: userId, targetChannelId: channelId, details: {} } });
    res.status(201).json({
      message: 'Suscripción creada exitosamente',
      subscription
    });
  } catch (error) {
    console.error('Error creando suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/subscriptions - Desuscribirse de un canal
router.delete('/', async (req, res) => {
  try {
    const { userId, channelId } = req.body;

    const subscription = await prisma.channelSubscription.findUnique({
      where: {
        userId_channelId: {
          userId,
          channelId
        }
      }
    });

    if (!subscription) {
      return res.status(404).json({ error: 'Suscripción no encontrada' });
    }

    // Desactivar suscripción (soft delete)
    await prisma.channelSubscription.update({
      where: { id: subscription.id },
      data: { isActive: false }
    });

    // Decrementar contador de miembros solo si es mayor a 0
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { memberCount: true }
    });

    if (channel && (channel.memberCount || 0) > 0) {
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          memberCount: {
            decrement: 1
          }
        }
      });
    }

    await prisma.auditLog.create({ data: { actorId: req.body.userId, action: 'USER_UNSUBSCRIBE', targetUserId: req.body.userId, targetChannelId: channelId, details: {} } });
            res.json({ message: 'Desuscripción exitosa' });
  } catch (error) {
    console.error('Error eliminando suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/subscriptions/user/:userId - Obtener suscripciones del usuario
router.get('/user/:userId', async (req, res) => {
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
            _count: {
              select: { messages: true }
            }
          }
        }
      },
      orderBy: { subscribedAt: 'desc' }
    });

    res.json(subscriptions);
  } catch (error) {
    console.error('Error obteniendo suscripciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
router.patch('/preferences/favorite', async (req, res) => {
  try {
    const { userId, channelId, isFavorite } = req.body;
    const sub = await prisma.channelSubscription.findUnique({
      where: { userId_channelId: { userId, channelId } }
    });
    if (!sub) return res.status(404).json({ error: 'Suscripción no encontrada' });
    const updated = await prisma.channelSubscription.update({
      where: { id: sub.id },
      data: { isFavorite: !!isFavorite }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando favorito' });
  }
});

router.patch('/preferences/receive', async (req, res) => {
  try {
    const { userId, channelId, receive } = req.body;
    const sub = await prisma.channelSubscription.findUnique({
      where: { userId_channelId: { userId, channelId } }
    });
    if (!sub) return res.status(404).json({ error: 'Suscripción no encontrada' });
    const updated = await prisma.channelSubscription.update({
      where: { id: sub.id },
      data: { receiveMessages: !!receive }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Error actualizando recepción' });
  }
});