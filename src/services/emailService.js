const nodemailer = require('nodemailer');

// Mock email service
const sendEmail = async (to, subject, html) => {
  console.log(`[Email Mock] Sending to: ${to}`);
  console.log(`[Email Mock] Subject: ${subject}`);
  // console.log(`[Email Mock] Body: ${html}`);
  
  // In a real environment, you would use:
  /*
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: '"Tify Events" <no-reply@tify.com>',
    to,
    subject,
    html,
  });
  */
  return true;
};

const sendPurchaseConfirmation = async (email, purchase, tickets) => {
  const ticketListHtml = tickets.map(t => `
    <div style="border: 1px solid #ccc; padding: 10px; margin-bottom: 10px;">
      <h3>Boleto: ${t.qrCode}</h3>
      <p>Evento: ${t.eventId}</p>
      <p>Zona: ${t.zoneId}</p>
      <p>Precio: $${t.price}</p>
    </div>
  `).join('');

  const html = `
    <h1>¡Gracias por tu compra, ${purchase.billingName}!</h1>
    <p>Hemos registrado tu compra exitosamente.</p>
    <p>Total: $${purchase.totalAmount}</p>
    <h2>Tus Boletos</h2>
    ${ticketListHtml}
    <p>Recuerda que puedes transferir tus boletos desde nuestra plataforma.</p>
  `;

  return sendEmail(email, 'Confirmación de Compra - Tify Events', html);
};

const sendTransferNotification = async (newOwnerEmail, ticket, senderName) => {
  const html = `
    <h1>¡Has recibido un boleto!</h1>
    <p>${senderName} te ha transferido un boleto.</p>
    <div style="border: 1px solid #ccc; padding: 10px; margin-bottom: 10px;">
      <h3>Código: ${ticket.qrCode}</h3>
      <p>Evento: ${ticket.eventId}</p>
    </div>
    <p>Disfruta el evento.</p>
  `;

  return sendEmail(newOwnerEmail, 'Te han transferido un boleto - Tify Events', html);
};

module.exports = {
  sendPurchaseConfirmation,
  sendTransferNotification
};
