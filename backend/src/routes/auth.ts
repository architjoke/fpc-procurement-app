import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../config/database.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, centreId: user.centreId },
      process.env.JWT_SECRET ?? 'development-secret',
      { expiresIn: '1h' },
    );

    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET ?? 'development-refresh-secret',
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
    return res.status(400).json({ message: 'Bad request.', error: (error as Error).message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const payload = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET ?? 'development-refresh-secret',
    ) as { sub: string };

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }

    const accessToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, centreId: user.centreId },
      process.env.JWT_SECRET ?? 'development-secret',
      { expiresIn: '1h' },
    );

    return res.json({ accessToken });
  } catch (error) {
    return res
      .status(401)
      .json({ message: 'Invalid refresh token.', error: (error as Error).message });
  }
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true, message: 'Logged out.' });
});

export { router as authRouter };
