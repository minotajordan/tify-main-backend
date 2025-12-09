const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const jwt = require('jsonwebtoken');

// Helper to get user ID from token
const getUserId = (req) => {
  const auth = req.headers.authorization || '';
  const [, token] = auth.split(' ');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    return payload.sub;
  } catch {
    return null;
  }
};

// GET /api/events - List events
router.get('/', async (req, res) => {
  try {
    const events = await prisma.event.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        organizer: {
          select: { id: true, username: true, fullName: true }
        },
        _count: {
          select: { zones: true, seats: true }
        }
      }
    });
    res.json(events);
  } catch (error) {
    console.error('Error getting events:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/events/:id - Get event details
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        organizer: {
          select: { id: true, username: true, fullName: true }
        },
        zones: {
          orderBy: { createdAt: 'asc' },
          include: {
            seats: true,
            _count: {
              select: { tickets: true }
            }
          }
        },
        seats: true
      }
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(event);
  } catch (error) {
    console.error('Error getting event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events - Create event
router.post('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    // For development, if no user found, maybe allow it or fail?
    // The schema requires organizerId.
    // If we are in dev mode and no auth, we might need a fallback or fail.
    // Let's assume there is a token.
    if (!userId) {
       // Fallback for dev: try to find the first user
       const firstUser = await prisma.user.findFirst();
       if (firstUser) {
         // Proceed with first user
         var organizerId = firstUser.id;
       } else {
         return res.status(401).json({ error: 'Unauthorized' });
       }
    } else {
      var organizerId = userId;
    }

    const {
      title,
      description,
      startDate,
      endDate,
      location,
      categories,
      paymentInfo,
      status
    } = req.body;

    const event = await prisma.event.create({
      data: {
        title,
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        location,
        categories: categories || [],
        paymentInfo,
        status: status || 'DRAFT',
        organizerId: organizerId
      }
    });

    res.status(201).json(event);
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id - Update event details
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      startDate,
      endDate,
      location,
      categories,
      paymentInfo,
      status
    } = req.body;

    const event = await prisma.event.update({
      where: { id },
      data: {
        title,
        description,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        location,
        categories,
        paymentInfo,
        status
      },
      include: {
        organizer: { select: { id: true, username: true, fullName: true } },
        zones: { include: { seats: true } },
        seats: true
      }
    });

    res.json(event);
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/events/:id/layout - Update event layout (zones and seats)
router.put('/:id/layout', async (req, res) => {
  try {
    const { id } = req.params;
    const { zones, seats } = req.body;

    await prisma.$transaction(async (tx) => {
      // Delete existing layout
      await tx.eventSeat.deleteMany({ where: { eventId: id } });
      await tx.eventZone.deleteMany({ where: { eventId: id } });
      
      // Create Zones and map old IDs to new DB IDs
      const zoneMap = new Map();
      
      if (zones && zones.length > 0) {
        for (const z of zones) {
          const createdZone = await tx.eventZone.create({
            data: {
              eventId: id,
              name: z.name,
              color: z.color,
              price: parseFloat(z.price || 0),
              rows: parseInt(z.rows || 0),
              cols: parseInt(z.cols || 0),
              capacity: parseInt(z.capacity || 0),
              type: z.type || 'SALE',
              layout: z.layout || { x: 0, y: 0 },
              seatGap: z.seatGap !== undefined ? parseInt(z.seatGap) : 4,
              startNumber: z.startNumber !== undefined ? parseInt(z.startNumber) : 1,
              numberingDirection: z.numberingDirection || 'LTR'
            }
          });
          zoneMap.set(z.id, createdZone.id);
        }
      }
      
      // Create Seats
      if (seats && seats.length > 0) {
        const seatsToCreate = seats.map(s => {
          const newZoneId = zoneMap.get(s.zoneId);
          if (!newZoneId) return null; // Skip if zone missing
          
          return {
            eventId: id,
            zoneId: newZoneId,
            rowLabel: s.rowLabel,
            colLabel: s.colLabel,
            status: s.status || 'AVAILABLE',
            type: s.type || 'REGULAR',
            price: s.price ? parseFloat(s.price) : null,
            x: s.x !== undefined ? parseInt(s.x) : null,
            y: s.y !== undefined ? parseInt(s.y) : null
          };
        }).filter(Boolean);
        
        if (seatsToCreate.length > 0) {
          await tx.eventSeat.createMany({
            data: seatsToCreate
          });
        }
      }
    });

    const updatedEvent = await prisma.event.findUnique({
      where: { id },
      include: {
        zones: { include: { seats: true } },
        seats: true,
        organizer: { select: { id: true, username: true, fullName: true } }
      }
    });

    res.json(updatedEvent);
  } catch (error) {
    console.error('Error updating layout:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events/:id/purchase - Process ticket purchase
router.post('/:id/purchase', async (req, res) => {
  try {
    const { id } = req.params;
    const { items, customer } = req.body; // items: [{ id, type, zoneId, price }]

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    const tickets = [];

    await prisma.$transaction(async (tx) => {
      // 1. Pre-validate capacity for all General Admission items in this batch
      const zoneCounts = {};
      for (const item of items) {
        if (item.type === 'general') {
          zoneCounts[item.zoneId] = (zoneCounts[item.zoneId] || 0) + 1;
        }
      }

      for (const [zoneId, count] of Object.entries(zoneCounts)) {
        const zone = await tx.eventZone.findUnique({
          where: { id: zoneId },
          include: { _count: { select: { tickets: true } } }
        });

        if (!zone) throw new Error(`Zone ${zoneId} not found`);
        
        // Check if (current_sold + requested_in_batch) > capacity
        if (zone.capacity && (zone._count.tickets + count > zone.capacity)) {
          throw new Error(`Zona ${zone.name}: Solo quedan ${zone.capacity - zone._count.tickets} boletos disponibles (solicitados: ${count})`);
        }
      }

      // 2. Process all items
      for (const item of items) {
        // Generate unique QR code data
        const qrCode = `${id}-${item.zoneId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        if (item.type === 'seat') {
          // Check if seat is available
          const seat = await tx.eventSeat.findUnique({
            where: { id: item.id }
          });

          if (!seat) throw new Error(`Seat ${item.id} not found`);
          if (seat.status !== 'AVAILABLE') throw new Error(`Seat ${seat.rowLabel}${seat.colLabel} is no longer available`);

          // Update seat status
          await tx.eventSeat.update({
            where: { id: item.id },
            data: { 
              status: 'SOLD',
              holderName: customer.fullName,
              ticketCode: qrCode
            }
          });

          // Create Ticket
          const ticket = await tx.ticket.create({
            data: {
              eventId: id,
              zoneId: item.zoneId,
              seatId: item.id,
              customerName: customer.fullName,
              customerEmail: customer.email,
              price: item.price,
              status: 'VALID',
              qrCode
            }
          });
          tickets.push(ticket);

        } else if (item.type === 'general') {
          // Double check not strictly needed if pre-check passed, but good for safety if logic changes
          // Skipping redundant DB call here for performance since we pre-validated the batch.
          
          // Create Ticket
          const ticket = await tx.ticket.create({
            data: {
              eventId: id,
              zoneId: item.zoneId,
              customerName: customer.fullName,
              customerEmail: customer.email,
              price: item.price,
              status: 'VALID',
              qrCode
            }
          });
          tickets.push(ticket);
        }
      }
    });

    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Error processing purchase:', error);
    res.status(400).json({ error: error.message || 'Purchase failed' });
  }
});

// GET /api/events/:id/stats - Get real-time stats
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [tickets, zones] = await Promise.all([
      prisma.ticket.findMany({
        where: { eventId: id, status: { not: 'CANCELLED' } },
        orderBy: { purchaseDate: 'desc' },
        include: { seat: true }
      }),
      prisma.eventZone.findMany({
        where: { eventId: id }
      })
    ]);

    const totalRevenue = tickets.reduce((sum, t) => sum + t.price, 0);
    const ticketsSold = tickets.length;
    
    // Revenue by zone
    const revenueByZone = zones.map(z => {
      const zoneTickets = tickets.filter(t => t.zoneId === z.id);
      return {
        id: z.id,
        name: z.name,
        count: zoneTickets.length,
        revenue: zoneTickets.reduce((sum, t) => sum + t.price, 0),
        capacity: z.capacity || (z.rows * z.cols) || 0
      };
    });

    res.json({
      totalRevenue,
      ticketsSold,
      revenueByZone,
      recentSales: tickets.slice(0, 10)
    });

  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/events/:id - Delete event
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if event exists
    const event = await prisma.event.findUnique({
      where: { id }
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Delete event (cascading will handle related data)
    await prisma.event.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
