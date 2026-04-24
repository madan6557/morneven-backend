# Morneven Backend

Backend implementation for Morneven Institute based on:
- `BERequierment.md` (API + RBAC contract)
- `Analasis BE Requierment.md` (architecture + relational schema guidance)

## Tech Stack
- Node.js + Express + TypeScript
- PostgreSQL + Prisma ORM
- JWT authentication (`access` + `refresh` token)
- Zod validation

## Project Structure
```text
src/
  config/        # env + prisma client
  middleware/    # auth guard + RBAC rules
  modules/       # feature routers by domain
    auth/
    projects/
    lore/
    gallery/
    map/
    personnel/
    settings/
    news/
  types/         # shared TS types + Express augmentation
  utils/         # shared response helper
  server.ts      # bootstrap + route mounting
prisma/
  schema.prisma
  seed.ts
```

## Implemented Modules
- Auth: login, register, me, logout, validate-token
- Lore: CRUD per category (`characters`, `places`, `technology`, `creatures`, `other`)
- Projects: CRUD + patch relation
- Gallery: CRUD + comments + replies + moderation rules
- Map: markers + map image
- Personnel: list/detail/create/update/delete + bulk update (L7 only)
- Settings: command center settings per user
- News: list/create/update/delete with role/track gate

## RBAC Highlights
- Level 7: full access
- Level 6 executive: full author panel + moderation + news write
- Level 6 mechanic: projects + technology + own gallery write
- Level 6 field: places + creatures + own gallery write
- Level 6 logistics: own gallery write only
- Level 0–5: read-only (except auth/self)

## Environment Variables
Create `.env` from `.env.example` and fill placeholders:

```env
DATABASE_URL="postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>?schema=public"
JWT_ACCESS_SECRET="<JWT_ACCESS_SECRET_PLACEHOLDER>"
JWT_REFRESH_SECRET="<JWT_REFRESH_SECRET_PLACEHOLDER>"
PORT=3000
```

## Install & Run
```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

## Seed Data
`prisma/seed.ts` seeds:
- L7 executive admin user
- L6 mechanic user
- settings, project + patch, news + attachment
- lore item + doc, gallery item + tags + discussion
- map markers + map image

> Seed uses placeholder URLs and non-production credentials.

## API Base URL
Development base path uses `/api`.
