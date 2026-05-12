import { AuthUser } from './auth.js';
import { SecurityContext } from '../security/context.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      securityContext?: SecurityContext;
    }
  }
}

export {};
