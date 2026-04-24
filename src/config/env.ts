import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT ?? 3000),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? '<JWT_ACCESS_SECRET_PLACEHOLDER>',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? '<JWT_REFRESH_SECRET_PLACEHOLDER>'
};
