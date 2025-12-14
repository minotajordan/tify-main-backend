const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const jwt = require('jsonwebtoken');
const { sendPurchaseConfirmation } = require('../services/emailService');

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

// GET /api/events/:id/tickets - List all tickets for an event
router.get('/:id/tickets', async (req, res) => {
  try {
    const { id } = req.params;
    const tickets = await prisma.ticket.findMany({
      where: { eventId: id },
      include: {
        zone: true,
        seat: true,
        purchase: true
      },
      orderBy: { purchaseDate: 'desc' }
    });
    res.json(tickets);
  } catch (error) {
    console.error('Error getting tickets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/events/:id/check-in - Check in a ticket
router.post('/:id/check-in', async (req, res) => {
  try {
    const { id } = req.params;
    const { code } = req.body; // Ticket ID or QR code value

    // Find ticket by ID or QR code
    const ticket = await prisma.ticket.findFirst({
      where: {
        eventId: id,
        OR: [
          { id: code },
          { qrCode: code }
        ]
      },
      include: {
        zone: true,
        seat: true
      }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket no encontrado' });
    }

    if (ticket.status === 'USED' || ticket.status === 'REFUNDED' || ticket.status === 'CANCELLED') {
      return res.status(400).json({ 
        error: `Ticket inválido (Estado: ${ticket.status})`,
        ticket 
      });
    }

    // Update status
    const updatedTicket = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'USED',
        checkInTime: new Date()
      }
    });

    res.json({
      success: true,
      message: 'Acceso concedido',
      ticket: updatedTicket
    });
  } catch (error) {
    console.error('Error checking in:', error);
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
              seatGapX: z.seatGapX !== undefined ? parseInt(z.seatGapX) : (z.seatGap !== undefined ? parseInt(z.seatGap) : 4),
              seatGapY: z.seatGapY !== undefined ? parseInt(z.seatGapY) : (z.seatGap !== undefined ? parseInt(z.seatGap) : 4),
              startNumber: z.startNumber !== undefined ? parseInt(z.startNumber) : 1,
              numberingDirection: z.numberingDirection || 'LTR',
              verticalDirection: z.verticalDirection || 'TTB',
              numberingMode: z.numberingMode || 'ROW',
              continuousNumbering: z.continuousNumbering || false,
              numberingSnake: z.numberingSnake || false,
              rowLabelType: z.rowLabelType || 'Alpha',
              rotation: parseInt(z.rotation || 0)
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
            y: s.y !== undefined ? parseInt(s.y) : null,
            gridRow: s.gridRow !== undefined ? parseInt(s.gridRow) : null,
            gridCol: s.gridCol !== undefined ? parseInt(s.gridCol) : null
          };
        }).filter(Boolean);
        
        if (seatsToCreate.length > 0) {
          await tx.eventSeat.createMany({
            data: seatsToCreate
          });
        }
      }
    }, {
      maxWait: 5000, // default: 2000
      timeout: 20000 // default: 5000
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

    // Verify event exists
    const eventExists = await prisma.event.findUnique({ where: { id } });
    if (!eventExists) {
      return res.status(404).json({ error: 'Evento no encontrado' });
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

      const zoneIdsToCheck = Object.keys(zoneCounts);
      if (zoneIdsToCheck.length > 0) {
        const zonesToCheck = await tx.eventZone.findMany({
          where: { id: { in: zoneIdsToCheck } },
          include: { _count: { select: { tickets: true } } }
        });

        for (const zoneId of zoneIdsToCheck) {
          const zone = zonesToCheck.find(z => z.id === zoneId);
          if (!zone) throw new Error(`Zona no encontrada (ID: ${zoneId})`);
          
          const count = zoneCounts[zoneId];
          // Check if (current_sold + requested_in_batch) > capacity
          if (zone.capacity !== null && (zone._count.tickets + count > zone.capacity)) {
            const remaining = Math.max(0, zone.capacity - zone._count.tickets);
            throw new Error(`Zona ${zone.name}: Solo quedan ${remaining} boletos disponibles (solicitados: ${count})`);
          }
        }
      }

      // 2. Create Purchase Record
      const purchase = await tx.ticketPurchase.create({
        data: {
          eventId: id,
          billingName: customer.fullName,
          billingEmail: customer.email,
          billingPhone: customer.phone || '',
          billingDocId: customer.docId || '',
          totalAmount: items.reduce((sum, item) => sum + parseFloat(item.price), 0)
        }
      });

      // 3. Optimization: Batch process items to reduce DB round-trips
      const seatItems = items.filter(i => i.type === 'seat');
      const generalItems = items.filter(i => i.type === 'general');
      const ticketsToCreate = [];
      const seatUpdates = [];

      // Process Seats (Batch Fetch & Update)
      if (seatItems.length > 0) {
        const seatIds = seatItems.map(i => i.id);
        
        // Fetch all seats in one query
        const dbSeats = await tx.eventSeat.findMany({
          where: { id: { in: seatIds } }
        });

        // Validate all seats exist
        if (dbSeats.length !== seatIds.length) {
          // Find which one is missing for better error message
          const foundIds = new Set(dbSeats.map(s => s.id));
          const missingId = seatIds.find(id => !foundIds.has(id));
          throw new Error(`Seat ${missingId} not found`);
        }

        // Validate availability
        const unavailableSeat = dbSeats.find(s => s.status !== 'AVAILABLE');
        if (unavailableSeat) {
          throw new Error(`Seat ${unavailableSeat.rowLabel}${unavailableSeat.colLabel} is no longer available`);
        }

        // Prepare updates and tickets
        for (const item of seatItems) {
          const qrCode = `${id}-${item.zoneId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          // Queue seat update (Parallel execution later)
          seatUpdates.push(
            tx.eventSeat.update({
              where: { id: item.id },
              data: { 
                status: 'SOLD',
                holderName: customer.fullName,
                ticketCode: qrCode
              }
            })
          );

          // Add to ticket creation list
          ticketsToCreate.push({
            eventId: id,
            zoneId: item.zoneId,
            seatId: item.id,
            purchaseId: purchase.id,
            customerName: customer.fullName,
            customerEmail: customer.email,
            ownerName: customer.fullName,
            ownerEmail: customer.email,
            ownerPhone: customer.phone || '',
            ownerDocId: customer.docId || '',
            price: item.price,
            status: 'VALID',
            qrCode
          });
        }
      }

      // Process General Admission
      for (const item of generalItems) {
        const qrCode = `${id}-${item.zoneId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        ticketsToCreate.push({
          eventId: id,
          zoneId: item.zoneId,
          purchaseId: purchase.id,
          customerName: customer.fullName,
          customerEmail: customer.email,
          ownerName: customer.fullName,
          ownerEmail: customer.email,
          ownerPhone: customer.phone || '',
          ownerDocId: customer.docId || '',
          price: item.price,
          status: 'VALID',
          qrCode
        });
      }

      // Execute all database operations
      // 1. Update all seats in parallel
      if (seatUpdates.length > 0) {
        await Promise.all(seatUpdates);
      }

      // 2. Create all tickets
      if (ticketsToCreate.length > 0) {
        // We use Promise.all instead of createMany to get the created ticket objects with IDs
        // This is necessary so the frontend can immediately perform actions like Transfer on the new tickets
        const createdTickets = await Promise.all(
          ticketsToCreate.map(data => tx.ticket.create({ data }))
        );
        
        tickets.push(...createdTickets);
      }
    }, {
      maxWait: 5000,
      timeout: 20000
    });

    // Send confirmation email asynchronously (don't block response)
    // We need to pass the purchase object and tickets. 
    // Since `purchase` variable is inside transaction scope, we need to extract it or reconstruct.
    // However, `purchase` is not available here. 
    // Let's refactor slightly to return purchase from transaction or just use the data we have.
    // We have `customer` and `items` and `tickets` (the array we pushed to).
    
    // Actually, `purchase` is created inside.
    // Let's just mock the purchase object for the email or move the variable out.
    // Better yet, just use the data we have available.
    const purchaseData = {
      billingName: customer.fullName,
      totalAmount: items.reduce((sum, item) => sum + parseFloat(item.price), 0)
    };
    
    sendPurchaseConfirmation(customer.email, purchaseData, tickets).catch(console.error);

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
