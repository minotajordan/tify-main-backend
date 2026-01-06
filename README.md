# Backend API - App de Mensajería Emergente

Backend Node.js con Express y Prisma ORM para la aplicación de mensajería emergente.

## Objetivo

Construir una plataforma de mensajería con jerarquía de canales y control robusto de visibilidad, aprobación y entrega de mensajes, con soporte para categorías globales y por canal, adjuntos condicionados a verificación/certificación, trazabilidad documental, perfiles de usuario personalizables y suscripción granular a subcanales.

## Características Clave

### Canales y Organización
- **Jerarquía y "Canal Principal"**: Cada canal puede tener un padre (canal principal) y múltiples subcanales.
- **Organizaciones**: Cada canal pertenece a una organización con NIT único.
- **Visibilidad y Acceso**:
    - Público/Privado (con contraseña).
    - Oculto (no listado) con opción de búsqueda exacta.
    - Código de referencia único para acceso directo.
- **Verificación**:
    - Estados: No verificado, Verificado, Verificado + Certificado.
    - Trazabilidad de documentos de soporte.

### Mensajería y Aprobación
- **Política de Aprobación**: Configurable por canal (Obligatorio, Opcional, Deshabilitado).
- **Aprobadores**: Asignados por canal. Override disponible para admins/coordinadores.
- **Categorías**:
    - Globales: General, Informativo, Emergente.
    - Por Canal: Categorías exclusivas.
- **Prioridad y Emergencia**: Soporte para mensajes de alta prioridad y envío inmediato (solo emergencias).
- **Adjuntos**: Archivos, links y multimedia (restringido a canales verificados).

### Usuarios y Suscripciones
- **Suscripción Granular**: Usuarios pueden suscribirse a canales específicos, marcar favoritos y silenciar subcanales.
- **Perfil de Usuario**: Extensible, con soporte para ubicación y datos adicionales.
- **Verificación de Teléfono**: Requisito para suscripciones múltiples.
- **Multi-Plataforma**: Soporte para WhatsApp, Telegram, Email, Push y SMS.

### Encuestas y Eventos (Tify)
- **Encuestas (Forms)**:
    - Tipos: Estándar y Votación.
    - Control de acceso: Público, Privado, Whitelist.
    - Fechas de inicio y cierre programadas.
    - Estados: Borrador, Programado, Activo, Finalizado.
- **Eventos**:
    - Gestión de aforo y zonas (mapas de asientos).
    - Venta de tickets y códigos QR.
    - Lista de invitados y RSVP.

## Modelo de Datos (Resumen)

- **Organization**: Entidad raíz con NIT.
- **Channel**: Unidad principal de agrupación (con jerarquía).
- **Message**: Contenido, metadatos, estado de aprobación y entrega.
- **User**: Usuarios del sistema con perfiles y configuraciones.
- **Form**: Encuestas con lógica de fechas (startDate, expiresAt) y publicación.
- **Event**: Eventos con fechas, ubicación y gestión de tickets.

## 🚀 Configuración rápida

```bash
# Instalar dependencias
cd backend
npm install

# Configurar base de datos
npx prisma generate
npx prisma db push

# Iniciar servidor de desarrollo
npm run dev
```

## 📁 Estructura del proyecto

```
backend/
├── src/
│   ├── config/
│   │   └── database.js          # Configuración Prisma
│   ├── routes/
│   │   ├── channels.js          # Rutas de canales
│   │   ├── messages.js          # Rutas de mensajes
│   │   ├── users.js             # Rutas de usuarios
│   │   └── subscriptions.js     # Rutas de suscripciones
│   └── server.js                # Servidor principal
├── prisma/
│   └── schema.prisma            # Esquema de base de datos
├── package.json
└── .env                         # Variables de entorno
```
