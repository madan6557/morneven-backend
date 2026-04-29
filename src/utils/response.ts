import { Response } from 'express';

export const ok = (res: Response, data: unknown, message?: string) => res.json({ success: true, message, data });

export const fail = (
  res: Response,
  code: number,
  message: string,
  errorCode = 'REQUEST_ERROR',
  errors?: unknown
) => res.status(code).json({ success: false, message, errorCode, errors });
