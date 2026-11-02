import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'centre_operator' | 'office_manager';
    centreId?: string | null;
  };
}

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET ?? 'development-secret';
    const decoded = jwt.verify(token, secret) as {
      sub: string;
      email: string;
      role: 'centre_operator' | 'office_manager';
      centreId?: string | null;
    };

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      centreId: decoded.centreId ?? null,
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
