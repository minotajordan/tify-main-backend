const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();

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
  const { title, description, headerContent, footerContent, successMessage, expiresAt, isPublished, wasPublished, fields } = req.body;
  const slug = Math.random().toString(36).substring(2, 10); // Simple slug generation

  try {
    const form = await prisma.form.create({
      data: {
        title,
        description,
        headerContent,
        footerContent,
        successMessage,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isPublished: isPublished || false,
        wasPublished: wasPublished || isPublished || false,
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
  const { title, description, headerContent, footerContent, successMessage, isActive, expiresAt, isPublished, wasPublished, fields } = req.body;

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
          successMessage,
          isActive,
          isPublished,
          wasPublished,
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
  const { data } = req.body;

  try {
    const form = await prisma.form.findUnique({ where: { slug } });
    if (!form || !form.isActive) return res.status(404).json({ error: 'Form not available' });

    const submission = await prisma.formSubmission.create({
      data: {
        formId: form.id,
        data: data
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

    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching submissions' });
  }
});

module.exports = router;
