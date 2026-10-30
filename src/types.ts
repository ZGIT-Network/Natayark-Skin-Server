import type { User } from './services/user.js';

import type { SessionData } from './services/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionData | null;
    currentUser: User | null;
    csrfToken(): string;
    checkCsrf(token?: string): boolean;
    setSession(uid: number): Promise<void>;
    clearSession(): Promise<void>;
    t(key: string): string;
  }
}
