const express = require('express');
const router = express.Router();
const prisma = require('../config/database');

router.get('/bootstrap', async (req, res) => {
  try {
    const userId = (req.query.userId || req.query.userid || '').toString();

    const [channels, subscriptions, stats, user, userProfile, userMessages, recommended] = await Promise.all([
      prisma.channel.findMany({
        where: {},
        include: {
          owner: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
          subchannels: { select: { id: true, title: true, icon: true, memberCount: true, description: true, parentId: true } },
          subscriptions: userId ? { where: { userId }, select: { isActive: true, isFavorite: true } } : false,
          _count: { select: { subscriptions: true } }
        },
        orderBy: { memberCount: 'desc' }
      }),
      userId ? prisma.channelSubscription.findMany({
        where: { userId, isActive: true },
        include: {
          channel: {
            include: {
              owner: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
              subchannels: { select: { id: true, title: true, icon: true, memberCount: true, description: true, parentId: true } }
            }
          }
        }
      }) : [],
      userId ? prisma.$queryRaw`SELECT 
        (SELECT COUNT(*) FROM tify_channel_subscriptions WHERE user_id = ${userId} AND is_active = true) AS subscribedChannelsCount,
        (SELECT COUNT(*) FROM tify_messages WHERE sender_id = ${userId}) AS messagesCount,
        (SELECT COUNT(*) FROM tify_channels WHERE owner_id = ${userId}) AS ownedChannelsCount` : [{ subscribedChannelsCount: 0, messagesCount: 0, ownedChannelsCount: 0 }],
      userId ? prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, username: true, fullName: true, avatarUrl: true, isGuest: true, phoneNumber: true, isPhoneVerified: true, isAdmin: true, isCoordinator: true } }) : null,
      userId ? prisma.userProfile.findUnique({ where: { userId }, select: { id: true, country: true, department: true, city: true, extra: true } }) : null,
      userId ? prisma.message.findMany({ where: { senderId: userId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, content: true, createdAt: true, priority: true, channel: { select: { id: true, title: true, icon: true } } } }) : [],
      userId ? prisma.$queryRawUnsafe(`
        SELECT c.id, c.title, c.description, c.icon, c.logo_url AS logoUrl, c.member_count AS memberCount, c.is_public AS isPublic, c.is_hidden AS isHidden, c.reference_code AS referenceCode, c.verification_status AS verificationStatus,
               COUNT(*) AS score
        FROM tify_channel_subscriptions s
        JOIN tify_channels c ON c.id = s.channel_id
        WHERE s.user_id IN (
          SELECT DISTINCT s2.user_id FROM tify_channel_subscriptions s2
          WHERE s2.channel_id IN (SELECT channel_id FROM tify_channel_subscriptions WHERE user_id = ? AND is_active = true)
            AND s2.user_id <> ? AND s2.is_active = true
        )
          AND s.channel_id NOT IN (SELECT channel_id FROM tify_channel_subscriptions WHERE user_id = ? AND is_active = true)
          AND s.is_active = true
        GROUP BY c.id
        ORDER BY score DESC, c.member_count DESC
        LIMIT 20
      `, userId, userId, userId) : []
    ]);

    const mappedChannels = channels.map(ch => ({
      ...ch,
      isSubscribed: userId ? (ch.subscriptions && ch.subscriptions.length > 0) : false,
      isFavorite: userId ? (ch.subscriptions && ch.subscriptions.some(s => s.isFavorite)) : false,
      subscriptions: undefined
    }));

    const favoriteChannels = subscriptions
      .filter(s => s.isFavorite)
      .map(s => ({ ...s.channel, isSubscribed: true, isFavorite: true }));

    const s = Array.isArray(stats) ? stats[0] : stats;
    let myChannels = [];
    if (userId) {
      myChannels = await Promise.all(subscriptions.map(async (sub) => {
        const ch = sub.channel;
        const lastMsg = await prisma.message.findFirst({
          where: { channelId: ch.id },
          orderBy: { createdAt: 'asc' },
          select: { id: true, content: true, createdAt: true, priority: true }
        });
        const unreadCount = await prisma.messageDelivery.count({
          where: { message: { channelId: ch.id }, userId, deliveryStatus: 'DELIVERED', readAt: null }
        });
        const subchannelSubs = await prisma.channelSubscription.findMany({
          where: { userId, isActive: true, channelId: { in: (ch.subchannels || []).map(s => s.id) } },
          select: { channelId: true, isFavorite: true }
        });
        const subchannelsWithFlags = (ch.subchannels || []).map(s => ({
          ...s,
          isSubscribed: subchannelSubs.some(ss => ss.channelId === s.id),
          isFavorite: subchannelSubs.some(ss => ss.channelId === s.id && ss.isFavorite)
        }));
        return {
          ...ch,
          isSubscribed: true,
          isFavorite: !!sub.isFavorite,
          lastMessageId: lastMsg ? lastMsg.id : null,
          lastMessagePreview: lastMsg ? String(lastMsg.content).slice(0, 140) : null,
          lastMessageAt: lastMsg ? lastMsg.createdAt : null,
          lastMessagePriority: lastMsg ? lastMsg.priority : null,
          unreadCount,
          subchannels: subchannelsWithFlags
        };
      }));
    }
    const payload = {
      channels: mappedChannels,
      favorites: favoriteChannels,
      myChannels,
      recommended: recommended.map(r => ({
        id: r.id,
        title: r.title,
        description: r.description,
        icon: r.icon,
        logoUrl: r.logoUrl,
        memberCount: r.memberCount,
        isPublic: r.isPublic,
        isHidden: r.isHidden,
        referenceCode: r.referenceCode,
        verificationStatus: r.verificationStatus,
        score: typeof r.score === 'bigint' ? Number(r.score) : r.score
      })),
      stats: {
        subscribedChannelsCount: typeof s.subscribedChannelsCount === 'bigint' ? Number(s.subscribedChannelsCount) : s.subscribedChannelsCount,
        messagesCount: typeof s.messagesCount === 'bigint' ? Number(s.messagesCount) : s.messagesCount,
        ownedChannelsCount: typeof s.ownedChannelsCount === 'bigint' ? Number(s.ownedChannelsCount) : s.ownedChannelsCount
      },
      user: user,
      profile: userProfile,
      messages: userMessages
    };
    res.set('Cache-Control', 'public, max-age=20, stale-while-revalidate=120');
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
    res.json(normalize(payload));
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo bootstrap', code: 'APP_BOOTSTRAP_FAILED', details: error.message });
  }
});

module.exports = router;
