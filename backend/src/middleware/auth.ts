import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'centre_operator' | 'office_manager';
    centreId: string | null;
  };
}

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  const secret = getJwtSecret('JWT_SECRET', 'development-secret');
  try {
    const decoded = jwt.verify(token, secret);

    if (
      typeof decoded === 'string' ||
      decoded.type !== 'access' ||
      typeof decoded.sub !== 'string' ||
      typeof decoded.email !== 'string' ||
      (decoded.role !== 'centre_operator' && decoded.role !== 'office_manager') ||
      (decoded.role === 'centre_operator' && typeof decoded.centreId !== 'string')
    ) {
      res.status(401).json({ message: 'Invalid or expired token.' });
      return;
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      centreId: typeof decoded.centreId === 'string' ? decoded.centreId : null,
    };
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

export const requireRole = (role: 'centre_operator' | 'office_manager') => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    if (req.user.role !== role) {
      res.status(403).json({ message: 'Forbidden.' });
      return;
    }

    next();
  };
};

export const centreScope = (
  user: NonNullable<AuthenticatedRequest['user']>,
): { centreId?: string } => {
  return user.role === 'centre_operator' ? { centreId: user.centreId ?? undefined } : {};
};
