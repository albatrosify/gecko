import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb, docWithId } from './db.ts';

const JWT_SECRET = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set. Security risk: cannot start without a secret. Please check your .env file or Docker environment configuration.');
  }
  return secret;
};
const TOKEN_EXPIRY = '7d';

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

export function createAuthRouter(): Router {
  const router = Router();

  // Register
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }

      const db = getDb();
      const { eq, count } = await import('drizzle-orm');
      const { users } = await import('./schema.ts');
      const { generateId } = await import('./db.ts');

      const existing = db.select().from(users).where(eq(users.email, email)).get();
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      // First user becomes admin
      const resultCount = db.select({ value: count() }).from(users).get();
      const role = (resultCount?.value || 0) === 0 ? 'admin' : 'user';

      const hashedPassword = await bcrypt.hash(password, 12);
      const newId = generateId();

      db.insert(users).values({
        id: newId,
        email,
        password: hashedPassword,
        role,
        createdAt: new Date(),
      }).run();

      const token = jwt.sign(
        { id: newId, email, role },
        JWT_SECRET(),
        { expiresIn: TOKEN_EXPIRY }
      );

      res.status(201).json({
        token,
        user: { id: newId, email, role },
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const db = getDb();
      const { eq } = await import('drizzle-orm');
      const { users } = await import('./schema.ts');

      const user = db.select().from(users).where(eq(users.email, email)).get();
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET(),
        { expiresIn: TOKEN_EXPIRY }
      );

      res.json({
        token,
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Get current user
  router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
    res.json({ user: req.user });
  });

  return router;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET()) as any;
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Like requireAuth but also accepts the token as a `?token=` query param.
 * Only intended for browser-initiated downloads where setting headers is not possible.
 */
export function requireAuthOrQuery(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const rawToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query.token as string | undefined);

  if (!rawToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(rawToken, JWT_SECRET()) as any;
    req.user = { id: decoded.id, email: decoded.email, role: decoded.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
