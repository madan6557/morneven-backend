import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { fail } from '../utils/response.js';

export const validateBody = <T>(schema: ZodSchema<T>) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  }

  req.body = parsed.data;
  return next();
};
