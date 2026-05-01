import { Request } from 'express';

const positiveInt = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const parsePagination = (req: Request, defaults = { pageSize: 24, maxPageSize: 100 }) => {
  const cursorPage = req.query.cursor ? Number(req.query.cursor) : undefined;
  const page = positiveInt(cursorPage ?? req.query.page, 1);
  const requestedPageSize = positiveInt(req.query.limit ?? req.query.pageSize, defaults.pageSize);
  const pageSize = Math.min(requestedPageSize, defaults.maxPageSize);

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize
  };
};

export const paginated = <T>(items: T[], page: number, pageSize: number, total: number) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasNextPage = page < totalPages;
  const pageInfo = {
    page,
    pageSize,
    total,
    totalPages,
    hasNextPage,
    nextCursor: hasNextPage ? String(page + 1) : null
  };

  return {
    items,
    ...pageInfo,
    pageInfo
  };
};

export const parseIds = (value: unknown) => {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

export const getSearchQuery = (req: Request) => String(req.query.q ?? req.query.search ?? '').trim();
