import { Role } from '@prisma/client';
import { AuthUser } from '../../types/auth.js';

const ROLE_SECURITY = 'security' as Role;
const ROLE_ADMIN = 'admin' as Role;

export const isSecurityManager = (user: AuthUser) => user.role === ROLE_SECURITY;

export const isPl7Author = (user: AuthUser) => user.level >= 7 && user.role === Role.author;

export const isPl7Admin = (user: AuthUser) => user.level >= 7 && user.role === ROLE_ADMIN;

export const canReadSecurity = (user: AuthUser) => isSecurityManager(user) || isPl7Author(user) || isPl7Admin(user);

export const canManageSecurity = (user: AuthUser) => canReadSecurity(user);
