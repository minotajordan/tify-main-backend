// /Users/minotajordan/WebstormProjects/tify/backend/src/routes/auth.js
const express = require('express');
const router = express.Router();
const prisma = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function signToken(user) {
  return jwt.sign({ sub: user.id, isAdmin: user.isAdmin }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
}

router.get('/has-users', async (req, res) => {
  try {
    const count = await prisma.user.count();
    res.json({ hasUsers: count > 0 });
  } catch (error) {
    res.status(500).json({ error: 'Error consultando usuarios', code: 'USERS_CHECK_FAILED', details: error.message });
  }
});

router.get('/needs-bootstrap', async (req, res) => {
  try {
    const count = await prisma.user.count();
    if (count === 0) return res.json({ needsBootstrap: true, targetUsername: 'tify_user' });
    const targetUsername = 'tify_user';
    const exists = await prisma.user.findUnique({ where: { username: targetUsername } });
    res.json({ needsBootstrap: !exists, targetUsername });
  } catch (error) {
    res.status(500).json({ error: 'Error evaluando bootstrap', code: 'BOOTSTRAP_CHECK_FAILED', details: error.message });
  }
});

router.post('/bootstrap-admin', async (req, res) => {
  try {
    const count = await prisma.user.count();
    if (count > 0) return res.status(403).json({ error: 'Ya existen usuarios', code: 'USERS_ALREADY_PRESENT' });

    const { code, email, username, fullName, password, phoneNumber } = req.body;
    const expected = process.env.BOOTSTRAP_CODE;
    if (!expected) return res.status(500).json({ error: 'BOOTSTRAP_CODE no configurado', code: 'BOOTSTRAP_CODE_MISSING' });
    if (!code || code !== expected) return res.status(403).json({ error: 'Código de verificación inválido', code: 'INVALID_BOOTSTRAP_CODE' });

    if (!email || !username || !password) return res.status(400).json({ error: 'email, username y password son requeridos', code: 'VALIDATION_ERROR' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, username, fullName: fullName || username, phoneNumber: phoneNumber || null, passwordHash, isAdmin: true }
    });
    const token = signToken(user);
    res.status(201).json({ token, user: { id: user.id, email: user.email, username: user.username, fullName: user.fullName, isAdmin: user.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: 'Error creando admin inicial', code: 'BOOTSTRAP_FAILED', details: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'identifier y password son requeridos', code: 'VALIDATION_ERROR' });
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      select: { id: true, email: true, username: true, fullName: true, isAdmin: true, passwordHash: true, isDisabled: true }
    });
    if (!user?.passwordHash) return res.status(401).json({ error: 'Credenciales inválidas', code: 'INVALID_CREDENTIALS' });
    if (user.isDisabled) return res.status(403).json({ error: 'Usuario deshabilitado', code: 'USER_DISABLED' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas', code: 'INVALID_CREDENTIALS' });
    const token = signToken({ id: user.id, isAdmin: user.isAdmin });
    try { await prisma.auditLog.create({ data: { actorId: user.id, action: 'USER_LOGIN', targetUserId: user.id, details: {} } }); } catch {}
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, fullName: user.fullName, isAdmin: user.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: 'Error en inicio de sesión', code: 'LOGIN_FAILED', details: error.message });
  }
});

router.post('/request-password-reset', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier) return res.status(400).json({ error: 'identifier requerido', code: 'VALIDATION_ERROR' });
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      select: { id: true }
    });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    if (user) {
      await prisma.user.update({ where: { id: user.id }, data: { verificationCode: code, verificationCodeExpiresAt: expires } });
    }
    res.json({ ok: true, message: 'Si el usuario existe, se ha enviado un código', requestedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Error solicitando reset', code: 'REQUEST_RESET_FAILED', details: error.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { identifier, code, newPassword } = req.body;
    if (!identifier || !code || !newPassword) return res.status(400).json({ error: 'identifier, code y newPassword son requeridos', code: 'VALIDATION_ERROR' });
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      select: { id: true, verificationCode: true, verificationCodeExpiresAt: true, email: true, username: true, fullName: true, isAdmin: true }
    });
    if (!user || !user.verificationCode || user.verificationCode !== code) return res.status(403).json({ error: 'Código inválido', code: 'INVALID_CODE' });
    if (user.verificationCodeExpiresAt && user.verificationCodeExpiresAt < new Date()) return res.status(403).json({ error: 'Código expirado', code: 'CODE_EXPIRED' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash, verificationCode: null, verificationCodeExpiresAt: null } });
    const token = signToken(updated);
    res.json({ token, user: { id: updated.id, email: updated.email, username: updated.username, fullName: updated.fullName, isAdmin: updated.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: 'Error reseteando contraseña', code: 'RESET_FAILED', details: error.message });
  }
});

router.get('/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const [, raw] = auth.split(' ');
  if (!raw) return res.status(401).json({ error: 'Token no proporcionado', code: 'TOKEN_MISSING' });
  try {
    const payload = jwt.verify(raw, process.env.JWT_SECRET || 'dev_secret');
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, username: true, fullName: true, isAdmin: true }
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado', code: 'USER_NOT_FOUND' });
    res.json(user);
  } catch (error) {
    res.status(401).json({ error: 'Token inválido', code: 'TOKEN_INVALID', details: error.message });
  }
});

module.exports = router;