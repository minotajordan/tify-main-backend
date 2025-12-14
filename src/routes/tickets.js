const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const { sendTransferNotification } = require('../services/emailService');

// POST /api/tickets/transfer - Transfer a ticket
router.post('/transfer', async (req, res) => {
  try {
    const { ticketId, newOwner, currentOwnerEmail } = req.body;
    // newOwner: { name, email, phone, docId }
    
    if (!ticketId || !newOwner || !newOwner.email || !newOwner.name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify ticket exists
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { event: true }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Verify ownership (optional security check if we had auth)
    // For now, we assume the caller has the right to transfer if they have the ID and current email matches.
    if (currentOwnerEmail && ticket.ownerEmail !== currentOwnerEmail) {
      return res.status(403).json({ error: 'Unauthorized transfer' });
    }

    // Perform transfer
    const updatedTicket = await prisma.$transaction(async (tx) => {
      // Create transfer record
      await tx.ticketTransfer.create({
        data: {
          ticketId: ticket.id,
          previousOwnerName: ticket.ownerName,
          previousOwnerEmail: ticket.ownerEmail,
          newOwnerName: newOwner.name,
          newOwnerEmail: newOwner.email
        }
      });

      // Update ticket owner
      return await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          ownerName: newOwner.name,
          ownerEmail: newOwner.email,
          ownerPhone: newOwner.phone || null,
          ownerDocId: newOwner.docId || null
        }
      });
    });

    // Send notification
    sendTransferNotification(newOwner.email, updatedTicket, ticket.ownerName).catch(console.error);

    res.json({ success: true, ticket: updatedTicket });
  } catch (error) {
    console.error('Error transferring ticket:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tickets/by-email - List tickets by email
router.get('/by-email', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const tickets = await prisma.ticket.findMany({
      where: { 
        ownerEmail: email,
        status: { not: 'CANCELLED' }
      },
      include: {
        event: {
          select: { title: true, startDate: true, location: true }
        },
        zone: {
          select: { name: true, color: true }
        },
        seat: {
          select: { rowLabel: true, colLabel: true }
        }
      },
      orderBy: { purchaseDate: 'desc' }
    });

    res.json(tickets);
  } catch (error) {
    console.error('Error listing tickets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
