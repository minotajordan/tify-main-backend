const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

// Helper to strip HTML tags
const stripHtml = (str) => {
  if (!str) return '';
  return str.replace(/<[^>]*>?/gm, '');
};

// Middleware de autenticación
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Obtener todos los formularios del usuario
router.get('/', authenticate, async (req, res) => {
  try {
    const forms = await prisma.form.findMany({
      where: { 
        userId: req.user.id,
        isDeleted: false
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { submissions: true }
        }
      }
    });
    res.json(forms);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching forms' });
  }
});

// Obtener un formulario específico (para edición)
router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const form = await prisma.form.findUnique({
      where: { id },
      include: { fields: { orderBy: { order: 'asc' } } }
    });

    if (!form || form.isDeleted) return res.status(404).json({ error: 'Form not found' });
    if (form.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    res.json(form);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching form' });
  }
});

// Crear un nuevo formulario
router.post('/', authenticate, async (req, res) => {
  const { title, description, headerContent, footerContent, successMessage, startDate, expiresAt, isPublished, wasPublished, fields, collectUserInfo, isWizard } = req.body;
  const slug = Math.random().toString(36).substring(2, 10); // Simple slug generation

  try {
    const form = await prisma.form.create({
      data: {
        title,
        description,
        headerContent,
        footerContent,
        successMessage: stripHtml(successMessage),
        startDate: startDate ? new Date(startDate) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isPublished: isPublished || false,
        wasPublished: wasPublished || isPublished || false,
        collectUserInfo: collectUserInfo || false,
        isWizard: isWizard || false,
        slug,
        userId: req.user.id,
        fields: {
          create: fields.map((field, index) => ({
            type: field.type,
            label: field.label,
            placeholder: field.placeholder,
            required: field.required,
            isHidden: field.isHidden || false,
            options: field.options,
            order: index
          }))
        }
      },
      include: { fields: true }
    });
    res.json(form);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error creating form' });
  }
});

// Actualizar un formulario
router.put('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const { title, description, headerContent, footerContent, successMessage, isActive, startDate, expiresAt, isPublished, wasPublished, fields, collectUserInfo, isWizard } = req.body;

  try {
    const existingForm = await prisma.form.findUnique({ where: { id } });
    if (!existingForm) return res.status(404).json({ error: 'Form not found' });
    if (existingForm.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    // Transaction to update form and replace fields
    const updatedForm = await prisma.$transaction(async (tx) => {
      // Update basic info
      const form = await tx.form.update({
        where: { id },
        data: {
          title,
          description,
          headerContent,
          footerContent,
          successMessage: stripHtml(successMessage),
          isActive,
          isPublished,
          wasPublished,
          collectUserInfo,
          isWizard,
          expiresAt: expiresAt ? new Date(expiresAt) : null
        }
      });

      // If fields are provided, replace them
      if (fields) {
        await tx.formField.deleteMany({ where: { formId: id } });
        await tx.formField.createMany({
          data: fields.map((field, index) => ({
            formId: id,
            type: field.type,
            label: field.label,
            placeholder: field.placeholder,
            required: field.required,
            isHidden: field.isHidden || false,
            options: field.options ?? undefined,
            order: index
          }))
        });
      }

      return form;
    });

    res.json(updatedForm);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error updating form' });
  }
});

// Eliminar un formulario
router.delete('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const form = await prisma.form.findUnique({ where: { id } });
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (form.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    // Soft delete
    await prisma.form.update({
      where: { id },
      data: { isDeleted: true, isPublished: false, isActive: false }
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting form' });
  }
});

// --- Rutas Públicas ---

// Obtener formulario por slug (para renderizar públicamente)
router.get('/public/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const form = await prisma.form.findUnique({
      where: { slug },
      include: { fields: { orderBy: { order: 'asc' } } }
    });

    if (!form) return res.status(404).json({ error: 'Form not found' });
    
    // Handle deleted state
    if (form.isDeleted) {
      return res.status(410).json({ 
        error: 'Form deleted',
        status: 'deleted',
        message: 'This form has been deleted and is no longer available.'
      });
    }

    // Handle paused/inactive state (using isPublished for pause logic based on user request)
    // User requested: "pausar formulario".
    // We assume !isPublished = Paused (if it was published before, or just draft).
    // Or we can check isActive.
    // Let's use !isPublished OR !isActive as "Unavailable".
    if (!form.isPublished || !form.isActive) {
      return res.status(403).json({ 
        error: 'Form is inactive',
        status: 'paused',
        message: 'This form is currently paused or not accepting submissions.'
      });
    }

    // No devolvemos info sensible del usuario creador, solo lo necesario
    res.json(form);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching form' });
  }
});

// Enviar respuesta al formulario
router.post('/public/:slug/submit', async (req, res) => {
  const { slug } = req.params;
  const { data, deviceInfo, country, city } = req.body;
  
  // Extract tracking info
  const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  try {
    const form = await prisma.form.findUnique({ where: { slug } });
    if (!form || !form.isActive) return res.status(404).json({ error: 'Form not available' });

    const now = new Date();
    if (form.startDate && now < new Date(form.startDate)) {
       return res.status(403).json({ error: 'Form not yet available' });
    }
    if (form.expiresAt && now > new Date(form.expiresAt)) {
       return res.status(403).json({ error: 'Form expired' });
    }

    const submission = await prisma.formSubmission.create({
      data: {
        formId: form.id,
        data: data,
        ipAddress: ipAddress ? (Array.isArray(ipAddress) ? ipAddress[0] : ipAddress.split(',')[0].trim()) : null,
        userAgent,
        deviceInfo: deviceInfo || undefined,
        country: country || null,
        city: city || null
      }
    });

    res.json({ success: true, id: submission.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error submitting form' });
  }
});

// --- Rutas de Resultados (Protegidas) ---

// Obtener sumisiones de un formulario
router.get('/:id/submissions', authenticate, async (req, res) => {
  const { id } = req.params;
  try {
    const form = await prisma.form.findUnique({ where: { id } });
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (form.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    const submissions = await prisma.formSubmission.findMany({
      where: { formId: id },
      orderBy: { createdAt: 'desc' }
    });

    // If tracking is not enabled by the user, we redact the sensitive columns
    // The data is still in DB (available to Admin/System), but not shown to the Form Owner via API
    // unless they enabled 'collectUserInfo'
    const cleanSubmissions = submissions.map(sub => {
      if (!form.collectUserInfo) {
        return {
          ...sub,
          ipAddress: null,
          userAgent: null,
          country: null,
          city: null,
          deviceInfo: null
        };
      }
      return sub;
    });

    res.json(cleanSubmissions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching submissions' });
  }
});

// Obtener estadísticas públicas del formulario (para votaciones/encuestas)
router.get('/public/:slug/stats', async (req, res) => {
  const { slug } = req.params;
  try {
    const form = await prisma.form.findUnique({
      where: { slug },
      include: { fields: true }
    });

    if (!form || !form.isActive) return res.status(404).json({ error: 'Form not found' });

    // Fetch all submissions data
    const submissions = await prisma.formSubmission.findMany({
      where: { formId: form.id },
      select: { data: true }
    });

    // Aggregation Logic
    const stats = {};
    
    // Iterate over fields to find votable fields (select, radio, voting options)
    // We mainly care about the first field for simple voting, or all select/radio fields
    const votingFields = form.fields.filter(f => 
      f.type === 'select' || f.type === 'radio' || f.type === 'checkbox'
    );

    votingFields.forEach(field => {
      const fieldStats = {};
      
      // Initialize options with 0 if possible
      if (field.options && Array.isArray(field.options)) {
        field.options.forEach(opt => {
           // Handle object options or string options
           const label = typeof opt === 'string' ? opt : opt.label;
           if (label) fieldStats[label] = 0;
        });
      }

      // Count votes
      submissions.forEach(sub => {
        const val = sub.data[field.label];
        if (val) {
          if (Array.isArray(val)) {
            val.forEach(v => {
               fieldStats[v] = (fieldStats[v] || 0) + 1;
            });
          } else {
             fieldStats[val] = (fieldStats[val] || 0) + 1;
          }
        }
      });

      // Calculate totals and percentages
      const total = Object.values(fieldStats).reduce((a, b) => a + b, 0);
      const results = Object.keys(fieldStats).map(key => ({
        label: key,
        count: fieldStats[key],
        percent: total > 0 ? Math.round((fieldStats[key] / total) * 100) : 0
      }));
      
      // Sort by count desc
      results.sort((a, b) => b.count - a.count);

      stats[field.label] = results;
    });

    res.json(stats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

module.exports = router;
