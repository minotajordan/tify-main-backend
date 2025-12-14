
// const fetch = require('node-fetch'); // Assuming node-fetch is available or using native fetch in Node 18+

const BASE_URL = 'http://localhost:3333/api';

async function testTransferFlow() {
  try {
    console.log('--- Starting Transfer Flow Test ---');

    // 1. Create Event
    console.log('Creating Event...');
    const eventRes = await fetch(`${BASE_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Transfer Test Event',
        description: 'Testing ticket transfer',
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 86400000).toISOString(),
        location: 'Test Location',
        organizerId: 'user-123' // Mock
      })
    });
    
    if (!eventRes.ok) throw new Error(`Create event failed: ${await eventRes.text()}`);
    const event = await eventRes.json();
    console.log(`Event created: ${event.id}`);

    // 2. Add Zone
    console.log('Adding Zone...');
    const layoutRes = await fetch(`${BASE_URL}/events/${event.id}/layout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zones: [{
          id: 'temp-zone-1',
          name: 'General VIP',
          color: '#ff0000',
          price: 100,
          capacity: 10,
          type: 'SALE'
        }],
        seats: []
      })
    });
    if (!layoutRes.ok) throw new Error(`Layout update failed: ${await layoutRes.text()}`);
    const updatedEvent = await layoutRes.json();
    const zoneId = updatedEvent.zones[0].id;
    console.log(`Zone created: ${zoneId}`);

    // 3. Purchase Ticket
    console.log('Purchasing Ticket...');
    const buyerEmail = 'buyer@test.com';
    const purchaseRes = await fetch(`${BASE_URL}/events/${event.id}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          id: 'temp-item-1',
          type: 'general',
          zoneId: zoneId,
          price: 100
        }],
        customer: {
          fullName: 'Original Buyer',
          email: buyerEmail,
          phone: '1234567890',
          docId: 'DOC123'
        }
      })
    });

    if (!purchaseRes.ok) throw new Error(`Purchase failed: ${await purchaseRes.text()}`);
    const purchaseData = await purchaseRes.json();
    const ticket = purchaseData.tickets[0];
    console.log(`Ticket purchased: ${ticket.id}`);
    
    if (!ticket.id) throw new Error('Ticket ID is missing in response!');

    // 4. Transfer Ticket
    console.log('Transferring Ticket...');
    const newOwnerEmail = 'newowner@test.com';
    const transferRes = await fetch(`${BASE_URL}/tickets/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticketId: ticket.id,
        currentOwnerEmail: buyerEmail,
        newOwner: {
          name: 'New Owner',
          email: newOwnerEmail,
          phone: '0987654321',
          docId: 'DOC456'
        }
      })
    });

    if (!transferRes.ok) throw new Error(`Transfer failed: ${await transferRes.text()}`);
    const transferData = await transferRes.json();
    console.log('Transfer successful:', transferData);

    if (transferData.ticket.ownerEmail !== newOwnerEmail) {
      throw new Error('Ticket owner email was not updated correctly');
    }

    console.log('--- Test Passed Successfully ---');

    // Cleanup (Optional)
    // await fetch(`${BASE_URL}/events/${event.id}`, { method: 'DELETE' });

  } catch (error) {
    console.error('--- Test Failed ---');
    console.error(error);
  }
}

testTransferFlow();
