const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
});

// Manejo de conexión
prisma.$connect()
  .then(() => {
    console.log('✅ Conectado a la base de datos');
  })
  .catch((error) => {
    console.error('❌ Error conectando a la base de datos:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;