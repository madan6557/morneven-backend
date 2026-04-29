import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.header('x-request-id') || randomUUID();
  res.setHeader('x-request-id', requestId);
  next();
};
