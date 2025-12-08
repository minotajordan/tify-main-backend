const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function generateAdditionalMessages() {
  console.log('📨 Generando mensajes adicionales...')

  // Obtener todos los canales y usuarios
  const channels = await prisma.channel.findMany()
  const users = await prisma.user.findMany()

  const emergencyMessages = [
    '🚨 Activación protocolo de emergencia nivel 2. Personal esencial reportar inmediatamente.',
    '⚡ Falla eléctrica masiva sector sur. Cuadrillas trabajando en restauración del servicio.',
    '🌊 Alerta por creciente súbita del río. Evacuar zonas de riesgo inmediatamente.',
    '🔥 Incendio estructural Edificio Central. Bomberos en camino. Evacuar perímetro.',
    '🚑 Múltiple accidente vía principal km 45. Ambulancias despachadas. Evitar la zona.',
    '📢 Simulacro nacional de emergencia a las 11:00 AM. No es una emergencia real.',
    '🌪️ Alerta tornado zona rural. Buscar refugio en estructuras sólidas inmediatamente.',
    '☢️ Derrame de material peligroso autopista norte. Cerrada completamente por seguridad.'
  ]

  const regularMessages = [
    '📅 Reunión coordinadores mañana 9:00 AM sala de crisis para revisión protocolos.',
    '🎯 Campaña vacunación refuerzo COVID continúa. Citas disponibles todos los días.',
    '🚸 Operativo Escuelas Seguras activo. Mayor presencia policial en zonas educativas.',
    '🌡️ Ola de calor pronosticada próximos 5 días. Manténganse hidratados.',
    '🚗 Día sin carro este miércoles. Transporte público gratuito 6:00 AM - 8:00 PM.',
    '📚 Taller primeros auxilios sábado 2:00 PM Cruz Roja. Inscripciones abiertas.',
    '🎪 Festival de prevención desastres domingo plaza central. Actividades familias.',
    '💊 Jornada medicina preventiva centros comunitarios toda la semana.'
  ]

  let messageCount = 0

  // Generar mensajes para cada canal
  for (const channel of channels) {
    const channelOwner = users.find(u => u.id === channel.ownerId)
    if (!channelOwner) continue

    // Decidir cuántos mensajes generar (1-3 por canal)
    const numMessages = Math.floor(Math.random() * 3) + 1

    for (let i = 0; i < numMessages; i++) {
      const isEmergency = Math.random() < 0.3 // 30% probabilidad de emergencia
      const messages = isEmergency ? emergencyMessages : regularMessages
      const content = messages[Math.floor(Math.random() * messages.length)]

      const createdAt = new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000) // Últimos 3 días
      const durationSeconds = isEmergency ?
        Math.floor(Math.random() * 300) + 180 : // 3-8 minutos para emergencias
        Math.floor(Math.random() * 600) + 120   // 2-12 minutos para regulares

      const expiresAt = new Date(createdAt.getTime() + durationSeconds * 1000)

      await prisma.message.create({
        data: {
          channelId: channel.id,
          senderId: channelOwner.id,
          content: content,
          durationSeconds: durationSeconds,
          expiresAt: expiresAt,
          isEmergency: isEmergency,
          deliveryMethod: isEmergency ? 'BOTH' : (Math.random() < 0.7 ? 'PUSH' : 'BOTH'),
          createdAt: createdAt
        }
      })

      messageCount++
    }
  }

  console.log(`   ✅ ${messageCount} mensajes adicionales creados`)
}

async function simulateMessageDeliveries() {
  console.log('📬 Simulando entregas de mensajes...')

  const messages = await prisma.message.findMany({
    include: {
      channel: {
        include: {
          subscriptions: {
            where: { isActive: true }
          }
        }
      }
    }
  })

  let deliveryCount = 0

  for (const message of messages) {
    for (const subscription of message.channel.subscriptions) {
      const deliveryStatus = Math.random() < 0.85 ? 'DELIVERED' :
                           Math.random() < 0.95 ? 'READ' : 'FAILED'

      const deliveredAt = deliveryStatus !== 'FAILED' ?
        new Date(message.createdAt.getTime() + Math.random() * 300 * 1000) : // Hasta 5 min después
        null

      const readAt = deliveryStatus === 'READ' && deliveredAt ?
        new Date(deliveredAt.getTime() + Math.random() * 600 * 1000) : // Hasta 10 min después de entregado
        null

      await prisma.messageDelivery.create({
        data: {
          messageId: message.id,
          userId: subscription.userId,
          deliveryStatus: deliveryStatus,
          deliveryMethod: message.deliveryMethod,
          deliveredAt: deliveredAt,
          readAt: readAt
        }
      })

      deliveryCount++
    }
  }

  console.log(`   ✅ ${deliveryCount} entregas de mensajes simuladas`)
}

async function main() {
  console.log('🚀 Generando datos adicionales...')

  await generateAdditionalMessages()
  await simulateMessageDeliveries()

  console.log('✅ ¡Datos adicionales generados exitosamente!')
}

main()
  .catch((e) => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })