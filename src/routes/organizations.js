// /Users/minotajordan/WebstormProjects/tify/backend/src/routes/organizations.js
const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const jwt = require('jsonwebtoken');

router.get('/', async (req, res) => {
  try {
    const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(orgs);
  } catch (error) {
    res.status(500).json({ error: 'Error listando organizaciones', code: 'ORG_LIST_FAILED', details: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const [, token] = auth.split(' ');
    if (!token) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret'); } catch (e) { return res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: e.message }); }
    const requester = await prisma.user.findUnique({ where: { id: payload.sub }, select: { isAdmin: true } });
    if (!requester?.isAdmin) return res.status(403).json({ error: 'Acceso denegado', code: 'ACCESS_DENIED' });

    const { name, nit } = req.body;
    if (!name || !nit) return res.status(400).json({ error: 'name y nit son requeridos', code: 'VALIDATION_ERROR' });

    const org = await prisma.organization.create({ data: { name, nit } });
    res.status(201).json(org);
  } catch (error) {
    res.status(500).json({ error: 'Error creando organización', code: 'ORG_CREATE_FAILED', details: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) return res.status(404).json({ error: 'Organización no encontrada' });
    res.json(org);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo organización', code: 'ORG_GET_FAILED', details: error.message });
  }
});

module.exports = router;