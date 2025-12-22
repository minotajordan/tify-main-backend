# Backend API - App de Mensajería Emergente

Backend Node.js con Express y Prisma ORM para la aplicación de mensajería emergente.

Objetivo

Construir una plataforma de mensajería con jerarquía de canales y control robusto de visibilidad, aprobación y entrega de mensajes, con soporte para categorías globales y por canal, adjuntos condicionados a verificación/certificación, trazabilidad documental, perfiles de usuario personalizables y suscripción granular a subcanales.
Características Clave

Canales con jerarquía y “canal principal”: cada canal puede tener un padre (canal principal) y múltiples subcanales (backend/prisma/schema.prisma:39).
Organizaciones y NIT: cada canal pertenece a una organización con nit único.
Visibilidad y acceso:
Público/privado con contraseña.
Oculto (no listado) y opción de búsqueda solo por nombre exacto.
Código de referencia único para acceso/búsqueda.
Verificación/certificación:
Estados: no verificado, verificado, verificado + certificado.
Trazabilidad de documentos que respaldan verificación/certificación.
Aprobación de mensajes:
Aprobadores por canal (uno o varios).
Política por canal: obligatorio, opcional, deshabilitado.
Override por mensaje solo por admin o coordinator.
Categorías de mensajes:
Globales obligatorias: General, Informativo, Emergente.
Por canal: categorías exclusivas que no aplican globalmente.
Prioridad de mensajes: baja, media, alta.
Mensajes emergentes con envío “inmediato”.
Adjuntos (archivos, links, multimedia) permitidos solo en canales verificados/certificados.
Suscripciones de usuario:
Un usuario puede estar adscrito a uno o varios canales/subcanales.
Favoritos por canal/subcanal.
Elegir recibir/no recibir mensajes por subcanal.
Perfil de usuario:
Datos básicos; opcional país, departamento, ciudad/municipio.
Extensible con campos adicionales sin romper la lógica existente.
Teléfono único; para suscribirse a más de un canal requiere teléfono verificado.
Plataformas de mensajería: soporte para WhatsApp, Telegram, Email, Push, SMS.
Tablas con prefijo físico tify_ para aislamiento.
Modelo De Datos (Resumen)

Organization (tify_organizations): name, nit único, relación a Channel.
Channel (tify_channels):
Jerarquía: parentId.
Organización: organizationId.
Visibilidad: isPublic, isHidden, searchExactOnly, passwordHash.
Identificación: referenceCode único.
Verificación: verificationStatus con trazabilidad en ChannelVerificationDocument.
Aprobación: approvalPolicy.
Relaciones: messages, approvers, messageCategories, categories (categorías de canal), verificationDocs.
ChannelApprover (tify_channel_approvers): asigna usuarios aprobadores por canal (único por canal/usuario).
Message (tify_messages):
Contenido y metadatos: content, durationSeconds, expiresAt.
Categoría: categoryId (global o por canal).
Emergencia e inmediato: isEmergency, isImmediate.
Prioridad: priority.
Entrega: deliveryMethod.
Aprobación por mensaje: approvalOverride con approvalOverrideSetBy/At.
Relaciones: deliveries, approvals, attachments.
MessageApproval (tify_message_approvals): estado de aprobación por aprobador para cada mensaje.
MessageCategory (tify_message_categories):
scope: GLOBAL o CHANNEL.
Único por (channelId, name) para categorías de canal.
MessageAttachment (tify_message_attachments): type (FILE, LINK, MEDIA), url, metadata.
ChannelVerificationDocument (tify_channel_verification_docs): documentos y emisores/fechas.
ChannelCategory + ChannelCategoryAssignment:
Catálogo de categorías de canal y asignaciones a cada canal.
User (tify_users):
Teléfono único phoneNumber y isPhoneVerified.
Roles: isAdmin, isCoordinator.
Relaciones: messagesSent, messagesOverrideSet, messageDeliveries, messageApprovals, subscriptions, ownedChannels, approverAssignments, profile, messagingSettings, createdCategories.
UserProfile (tify_user_profiles): country, department, city, extra JSON.
UserMessagingSetting (tify_user_messaging_settings): plataforma, handle, habilitado, verificación.
ChannelSubscription (tify_channel_subscriptions): estado, isFavorite, receiveMessages.
InvitationLink (tify_invitation_links) y QrCode (tify_qr_codes): invitación/QR con control de expiración/uso.
Enums:
VerificationStatus: UNVERIFIED, VERIFIED, VERIFIED_CERTIFIED.
ApprovalPolicy: REQUIRED, OPTIONAL, DISABLED.
ApprovalStatus: PENDING, APPROVED, REJECTED.
MessagePriority: LOW, MEDIUM, HIGH.
CategoryScope: GLOBAL, CHANNEL.
AttachmentType: FILE, LINK, MEDIA.
MessagingPlatform y DeliveryMethod con WHATSAPP, TELEGRAM, EMAIL, PUSH, SMS.
Reglas De Negocio

Visibilidad y acceso:
isHidden=true excluye de listados; solo accesible por referenceCode o búsqueda exacta si searchExactOnly=true.
Canales privados requieren passwordHash válido para unirse.
Aprobación:
Si Channel.approvalPolicy=REQUIRED, mensajes requieren al menos una aprobación APPROVED por algún ChannelApprover.
OPTIONAL: se pueden enviar sin aprobación; si hay aprobaciones, se reflejan.
DISABLED: no se admiten aprobaciones en ese canal.
Message.approvalOverride puede cambiar la política solo si el overrideSetter es isAdmin o isCoordinator.
Categorías:
Crear globales base: “GENERAL”, “INFORMATIVO”, “EMERGENTE” (scope=GLOBAL).
isImmediate solo permitido si la categoría del mensaje es “EMERGENTE”.
Adjuntos:
Solo permitidos si Channel.verificationStatus ∈ {VERIFIED, VERIFIED_CERTIFIED}.
Adjuntos almacenan metadata (tamaño, tipo, checksums).
Suscripción:
Favoritos: ChannelSubscription.isFavorite.
Recepción por subcanal: ChannelSubscription.receiveMessages.
Más de un canal requiere User.isPhoneVerified=true.
Entrega:
Seleccionar deliveryMethod según UserMessagingSetting habilitada y verificada.
Estados de entrega: PENDING → DELIVERED → READ; FAILED ante error.
Búsqueda:
Si searchExactOnly=true, buscar por nombre debe ser exacto.
referenceCode ofrece acceso directo incluso si isHidden=true.
Flujos Principales

Creación de organización y canal:
Crear Organization con nit.
Crear Channel con organizationId, definir approvalPolicy, verificación inicial (UNVERIFIED).
Asignar ChannelApprover a usuarios aprobadores.
Definición de categorías:
Seed de categorías globales.
Crear categorías por canal cuando sea necesario (scope=CHANNEL).
Suscripción de usuario:
Validar teléfono único; para múltiples canales, exigir isPhoneVerified.
Elegir subcanales y marcar favoritos.
Envío de mensaje:
Validar categoría, prioridad y reglas de “inmediato”.
Validar adjuntos según verificación del canal.
Aplicar política de aprobación del canal o approvalOverride.
Aprobación:
Registrar MessageApproval por cada aprobador.
Publicar/entregar mensaje cuando cumpla política/override.
Entrega:
Enviar por deliveryMethod disponible en UserMessagingSetting.
Registrar MessageDelivery y actualizar estados.
Inicialización Y Seeds

Crear categorías globales:
“GENERAL”, “INFORMATIVO”, “EMERGENTE” en MessageCategory (scope=GLOBAL).
Opcional: crear Organization de prueba con nit, un canal verificado y aprobadores.
Configurar UserMessagingSetting por usuario para WHATSAPP/TELEGRAM si se utilizan.
Operación En Supabase

Conexión directa recomendada para operaciones de esquema:
datasource db usa url, directUrl y shadowDatabaseUrl directos (backend/prisma/schema.prisma:5–8).
Variables:
DATABASE_URL/DIRECT_URL/SHADOW_DATABASE_URL con ?schema=public&sslmode=require en 5432.
Comandos:
npx prisma format
npx prisma generate
BD vacía: npx prisma migrate dev --name init-fresh-db o npx prisma db push.
Reset: npx prisma migrate reset.
Seguridad

No almacenar contraseñas en claro; usar passwordHash con algoritmo robusto.
No exponer documentos de verificación sensibles; controlar acceso por rol.
No registrar secretos (JWT_SECRET, credenciales DB) en logs.
Validar entradas y sanitizar datos en adjuntos y links.
Aceptación (Checklist)

Canales y subcanales con visibilidad/privacidad, contraseña y búsqueda exacta/ref-code funcional.
Aprobadores por canal y política por defecto; override por admin/coordinator por mensaje.
Categorías globales y por canal funcionando; “Emergente” permite isImmediate.
Adjuntos bloqueados si el canal no está verificado/certificado; trazabilidad de verificación poblada.
Suscripción flexible a subcanales, favoritos y opt-in/out por subcanal.
Teléfono único y verificado para suscripción a múltiples canales.
Entregas registradas con estados y plataformas según configuración del usuario.
Todas las tablas físicas usan prefijo tify_.
Si quieres, preparo un seed inicial y ejemplos de consultas Prisma para crear: una organización con NIT, un canal verificado con aprobadores y las categorías globales.

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

## 🔗 Endpoints disponibles

### **Canales**
- `GET /api/channels` - Listar canales
- `GET /api/channels/:id` - Obtener canal específico
- `GET /api/channels/user/:userId/subscribed` - Canales suscritos
- `POST /api/channels/:id/validate-password` - Validar contraseña
- `POST /api/channels` - Crear canal
- `GET /api/channels/search?q=...&exact=...&referenceCode=...` - Buscar canal
- `POST /api/channels/:id/approvers` - Añadir aprobador
- `DELETE /api/channels/:id/approvers/:userId` - Eliminar aprobador
- `GET /api/channels/:id/verification-docs` - Listar documentos de verificación
- `POST /api/channels/:id/verification-docs` - Añadir documento de verificación
- `POST /api/channels/:id/categories` - Asignar categoría al canal

### **Mensajes**
- `GET /api/messages/channel/:channelId` - Mensajes de un canal
- `POST /api/messages` - Crear mensaje (categoría, prioridad, adjuntos, fecha de evento)
- `GET /api/messages/pending/approval` - Mensajes pendientes
- `POST /api/messages/:id/approve` - Aprobar mensaje
- `POST /api/messages/:id/reject` - Rechazar mensaje
- `POST /api/messages/:id/override` - Override política de aprobación
- `PUT /api/messages/:id` - Modificar mensaje con historial de revisiones

### **Usuarios**
- `GET /api/users/:id` - Perfil de usuario
- `PUT /api/users/:id` - Actualizar perfil
- `GET /api/users/:id/channels/owned` - Canales administrados
- `GET /api/users/:id/stats` - Estadísticas del usuario
- `POST /api/users/:id/messaging-settings` - Crear/ajustar plataforma
- `PUT /api/users/:id/messaging-settings/:platform` - Actualizar plataforma
- `POST /api/users/:id/verify-phone` - Verificar teléfono

### **Suscripciones**
- `POST /api/subscriptions` - Suscribirse a canal
- `DELETE /api/subscriptions` - Desuscribirse
- `GET /api/subscriptions/user/:userId` - Suscripciones del usuario
- `PATCH /api/subscriptions/preferences/favorite` - Marcar como favorito
- `PATCH /api/subscriptions/preferences/receive` - Preferencia recibir mensajes

## 🛠️ Comandos útiles

```bash
# Desarrollo
npm run dev                    # Servidor con auto-reload
npm start                     # Servidor de producción

# Base de datos
npx prisma generate           # Generar cliente Prisma
npx prisma db push           # Aplicar cambios al esquema
npx prisma studio            # Interfaz visual de BD

# Testing
npm test                     # Ejecutar tests
```

## 🔧 Variables de entorno

```env
DATABASE_URL=postgresql://...
PORT=3000
NODE_ENV=development
JWT_SECRET=tu_jwt_secret
CORS_ORIGIN=http://localhost:3000
```

## 📊 Health Check

```bash
curl http://localhost:3000/health
```

## 🚀 Ventajas del backend

### **Rendimiento mejorado:**
- ✅ **Cache inteligente** con Prisma
- ✅ **Consultas optimizadas** con includes selectivos
- ✅ **Paginación** en endpoints de listas
- ✅ **Rate limiting** para prevenir abuso

### **Escalabilidad:**
- ✅ **Arquitectura modular** por funcionalidades
- ✅ **Middleware reutilizable**
- ✅ **Manejo de errores centralizado**
- ✅ **Logging estructurado**

### **Seguridad:**
- ✅ **Helmet** para headers de seguridad
- ✅ **CORS** configurado
- ✅ **Validación de entrada**
- ✅ **Rate limiting**

La app móvil ahora se conectará a este backend en lugar de directamente a Supabase, mejorando significativamente el rendimiento y la experiencia del usuario.

## 🧪 Datos de prueba

- Canales privados (contraseña de prueba: `password`):
  - `Canal Privado Verificado` (`referenceCode`: `REF-PRIVATE-001`)
  - `Canal Privado Verificado 2` (`referenceCode`: `REF-PRIVATE-002`)
  - `Emergencias Barrio` (subcanal privado, `referenceCode`: `REF-EMERG-BARRIO-001`)

- Canales ocultos (usar `referenceCode` o búsqueda exacta):
  - `Canal Oculto` (`referenceCode`: `REF-HIDDEN-001`, exact-only)
  - `Canal Oculto 2` (`referenceCode`: `REF-HIDDEN-002`, exact-only)

- Jerarquía de canales:
  - `Red Nacional` (principal)
    - `Regional Norte` (subcanal)
    - `Regional Sur` (subcanal)
  - `Emergencias Ciudad` (principal verificado)
    - `Emergencias Barrio` (subcanal privado verificado)

### Universidades y JAC (Datos de prueba)

- Universidades:
  - `Universidad del Cauca` (NIT `890701308-1`)
    - `Unicauca - Comunicados Académicos` (`REF-UNICAUCA-ACAD-001`)
    - `Unicauca - Facultad de Ingeniería` (`REF-UNICAUCA-ING-001`) subcanal
    - `Unicauca - Emergencias Campus` (`REF-UNICAUCA-EMERG-001`) verificado, REQUIRED
    - `Unicauca - Admisiones Privadas` (`REF-UNICAUCA-ADM-001`) privado oculto, exact-only
  - `Colegio Mayor del Cauca` (NIT `891234567-2`)
    - `ColMayor - Comunicados Generales` (`REF-COLMAYOR-GEN-001`)
    - `ColMayor - Programas de Diseño` (`REF-COLMAYOR-DIS-001`) subcanal
    - `ColMayor - Emergencias Sede` (`REF-COLMAYOR-EMERG-001`) verificado y certificado, REQUIRED

- Juntas de Acción Comunal:
  - `JAC Barrio La Esmeralda` (NIT `904567890-3`)
    - `JAC Esmeralda - Comunicados` (`REF-JAC-ESM-GEN-001`)
    - `JAC Esmeralda - Seguridad` (`REF-JAC-ESM-SEG-001`) verificado, REQUIRED
    - `JAC Esmeralda - Eventos` (`REF-JAC-ESM-EVT-001`)
  - `JAC Barrio La Paz` (NIT `905678901-4`)
    - `JAC La Paz - Comunicados` (`REF-JAC-LP-GEN-001`)
    - `JAC La Paz - Seguridad` (`REF-JAC-LP-SEG-001`) verificado, REQUIRED
    - `JAC La Paz - Comercio` (`REF-JAC-LP-COM-001`) privado oculto, exact-only

- Contraseñas de canales privados: `password`
- Búsqueda exacta y por código:
  - `GET /api/channels/search?referenceCode=REF-UNICAUCA-ADM-001`
  - `GET /api/channels/search?q=JAC La Paz - Comercio&exact=true`

- Aprobadores:
  - Unicauca: `Unicauca - Emergencias Campus`, `Unicauca - Admisiones Privadas`
  - ColMayor: `ColMayor - Emergencias Sede`
  - JAC: `JAC Esmeralda - Seguridad`, `JAC La Paz - Seguridad`

- Ejemplos de prueba:
  - Enviar EMERGENTE inmediato a `REF-COLMAYOR-EMERG-001`
  - Crear mensaje con adjunto en `REF-UNICAUCA-ACAD-001`
  - Aprobar mensaje en `REF-JAC-ESM-SEG-001`

- Categorías globales: `GENERAL`, `INFORMATIVO`, `EMERGENTE`
- Categorías por canal: `ALERTA ESPECIAL`, `ALERTA SALUD`, `NOTICIA LOCAL`

- Aprobadores de canal (política REQUIRED):
  - `Canal Privado Verificado`, `Canal Privado Verificado 2`, `Emergencias Ciudad` y `Emergencias Barrio`

- Ejemplos útiles:
  - Buscar por código: `GET /api/channels/search?referenceCode=REF-PRIVATE-002`
  - Búsqueda exacta: `GET /api/channels/search?q=Canal Oculto&exact=true`
  - Validar contraseña: `POST /api/channels/:id/validate-password` body `{ "password": "password" }`
  - Aprobar mensaje: `POST /api/messages/:id/approve` body `{ "approverId": "<userId aprobador>" }`
  - Override política: `POST /api/messages/:id/override` body `{ "policy": "REQUIRED", "setterId": "<admin/coordinator>" }`
- Campos de trazabilidad en mensajes:
  - `createdAt` (creado/enviado), `publishedAt` (publicado), `updatedAt` (última modificación)
  - Historial de ediciones en `tify_message_revisions` con referencia a editor y versión previa
  - `eventAt` para fecha/hora de cumplimiento del mensaje (por ejemplo, hora de una reunión)
- Empresas y Alcaldía:
  - `Empresa ACME S.A.` (NIT `907890123-5`)
    - `ACME - Comunicados Corporativos` (`REF-ACME-CORP-001`)
    - `ACME - Seguridad Planta` (`REF-ACME-SEG-001`) verificado, REQUIRED
    - Mensajes con `eventAt`:
      - Reunión general de equipo (evento en 2 horas)
      - Simulacro de evacuación en planta A (evento en 30 minutos)
  - `Alcaldía de Popayán` (NIT `890399029-6`)
    - `Alcaldía - Comunicados` (`REF-MUNI-GEN-001`)
    - `Alcaldía - Emergencias` (`REF-MUNI-EMERG-001`) verificado, REQUIRED
    - `Alcaldía - Simulacro Evacuación Centro` (`REF-MUNI-SIM-001`) subcanal, verificado, REQUIRED
    - Mensajes con `eventAt`:
      - Alerta de inundación (evento en 45 minutos)
      - Simulacro de evacuación centro histórico (evento en 1 hora)

- Cómo probar `eventAt`:
  - Crear mensaje: `POST /api/messages` con `eventAt` ISO-8601
  - Ver publicación en canales `REQUIRED`: `POST /api/messages/:id/approve`
  - En el front, calcular `enviado hace` con `createdAt` y `evento en` con `eventAt`


  Es necesario que se pueda tener un apartado para que al crear un evento se pueda generar eventos para cumpleaños, días especiales, etc.

  de esta manera el apartado de generar un evento, al darle click en "Nuevo evento", me mostrar un modal muy hermoso, con el cual podre elegir si sera un evento macro, o un cumpleaños o evento loca,
  Debes especificar que el evento macro incluye tiketins, pagos reserva de sillas y varias cositas muy profesionales que es basicamente lo que ya esta 

  Y el evento local, incluye plantillas para cumpelaños, grados y cosas de este estilo, aqupi tambien se podra hacer reservas al compartir un link unico, se podra generar plantillas o crear plantillas para el evento, estas se enviaran en un link de acceso publico y se podra subir en la creacion den evento local, numeros, pais, nombres del invitado, cupos, para que al que se pueda tener un link unico y especial para cada invitado, de modo que al ingresar el ivitado ya esta identificado, y podra ver inforamcion del evento y confirmar desde allí su asistencia, es imporante que se añada el flujo de limite de asistentes, o nombdes de los invitado y cupos para esa invitacion


  ------------

  Necesito que me construtes todo un modulo para gestionar como acortador de Link y QR para poder tener un control de creacion, así puedo crear muchos link acortando direcciones web y que estos genere un QR, la idea es poder garantizar que rutas muy largas quedaran mucho cortas, mi url es tify.pro/L423SA
  Toda la ruta que inicie inmediatamente despues de dominio / que tenga un L mayuscula significa que es para Redireccionar.

  Este debe permitirme, links directos y links con tiempo, estos links claramnete tengan un QR ATADO que llevara a ese link, el link acortador podra ser modificado para cambiar el sitio al cual redirigie y me debe de permitir tener un historial de cambios, ademas de permitirme definit que quiero mostrar antes de que redireccione a la pagina o si quiero que se redieccione de inmediato.
  Recuerda que cuando redireccione es necesario.

  El usuario debe de tener la opcion de crear QR y automaticamnte este QR tendra un link cortico atado para que se cierre el flujo actuando com un ecosistema.