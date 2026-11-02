import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../config/database.js';
import { getJwtSecret } from '../config/jwt.js';

const router = Router();
const loginRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again in one minute.' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const logoutSchema = refreshSchema;

router.post('/login', loginRateLimit, async (req, res) => {
  const parsedInput = loginSchema.safeParse(req.body);
  if (!parsedInput.success) {
    return res.status(400).json({ message: 'Bad request.', error: parsedInput.error.flatten() });
  }

  try {
    const { email, password } = parsedInput.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        centreId: user.centreId,
        type: 'access',
      },
      getJwtSecret('JWT_SECRET', 'development-secret'),
      { expiresIn: '15m' },
    );

    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh', jti: randomUUID() },
      getJwtSecret('JWT_REFRESH_SECRET', 'development-refresh-secret'),
      { expiresIn: '7d' },
    );

    return res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        centreId: user.centreId,
      },
    });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ message: 'Unable to complete login.' });
  }
});

router.post('/refresh', async (req, res) => {
  const parsedInput = refreshSchema.safeParse(req.body);
  if (!parsedInput.success) {
    return res.status(400).json({ message: 'Bad request.', error: parsedInput.error.flatten() });
  }

  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(
      parsedInput.data.refreshToken,
      getJwtSecret('JWT_REFRESH_SECRET', 'development-refresh-secret'),
    );
    if (typeof verified === 'string') {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }
    payload = verified;
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token.' });
  }

  if (
    payload.type !== 'refresh' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    return res.status(401).json({ message: 'Invalid refresh token.' });
  }

  try {
    const revokedToken = await prisma.auditTrail.findFirst({
      where: {
        entityType: 'refresh_token',
        entityId: payload.jti,
        action: 'refresh_token_revoked',
      },
      select: { id: true },
    });
    if (revokedToken) {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }

    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        centreId: user.centreId,
        type: 'access',
      },
      getJwtSecret('JWT_SECRET', 'development-secret'),
      { expiresIn: '15m' },
    );

    return res.json({ accessToken });
  } catch (error) {
    console.error('Token refresh failed:', error);
    return res.status(500).json({ message: 'Unable to refresh session.' });
  }
});

router.post('/logout', async (req, res) => {
  const parsedInput = logoutSchema.safeParse(req.body);
  if (!parsedInput.success) {
    return res.status(400).json({ message: 'Bad request.', error: parsedInput.error.flatten() });
  }

  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(
      parsedInput.data.refreshToken,
      getJwtSecret('JWT_REFRESH_SECRET', 'development-refresh-secret'),
    );
    if (typeof verified === 'string') {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }
    payload = verified;
  } catch {
    return res.status(401).json({ message: 'Invalid refresh token.' });
  }

  if (
    payload.type !== 'refresh' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string'
  ) {
    return res.status(401).json({ message: 'Invalid refresh token.' });
  }

  try {
    await prisma.auditTrail.create({
      data: {
        actorUserId: payload.sub,
        action: 'refresh_token_revoked',
        entityType: 'refresh_token',
        entityId: payload.jti,
        after: JSON.stringify({
          revokedAt: new Date().toISOString(),
          expiresAt:
            typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
        }),
      },
    });

    return res.json({ ok: true, message: 'Logged out.' });
  } catch (error) {
    console.error('Logout failed:', error);
    return res.status(500).json({ message: 'Unable to log out.' });
  }
});

export { router as authRouter };
