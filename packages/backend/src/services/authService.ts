import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { UnauthorizedError } from '../lib/errors';
import { userRepository, type AuthUser } from '../repositories/userRepository';
import { auditRepository } from '../repositories/auditRepository';

/**
 * Authentication service (Service Layer, Epic 2).
 *
 * JWT-based stateless sessions. Passwords are bcrypt-hashed. Logout is recorded
 * for audit; token invalidation for Phase 1 is client-side (drop the token) —
 * a server-side denylist can be added later if required.
 */

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

export interface LoginResult {
  token: string;
  user: AuthUser;
}

export const authService = {
  async login(email: string, password: string): Promise<LoginResult> {
    const user = userRepository.findByEmail(email);
    // Constant-ish behaviour: always run a compare to reduce user-enumeration signal.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      throw new UnauthorizedError('Invalid email or password');
    }

    userRepository.recordLogin(user.id);
    const authUser = userRepository.toAuthUser(user);
    auditRepository.record(user.email, 'LOGIN');

    const payload: TokenPayload = { sub: user.id, email: user.email, role: authUser.role };
    const token = jwt.sign(payload, config.auth.jwtSecret, {
      expiresIn: config.auth.jwtExpiresIn,
    } as jwt.SignOptions);

    return { token, user: authUser };
  },

  verify(token: string): TokenPayload {
    try {
      return jwt.verify(token, config.auth.jwtSecret) as TokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
  },

  me(userId: string): AuthUser {
    const user = userRepository.findById(userId);
    if (!user) throw new UnauthorizedError('User not found or inactive');
    return userRepository.toAuthUser(user);
  },

  logout(email: string): void {
    auditRepository.record(email, 'LOGOUT');
  },
};
