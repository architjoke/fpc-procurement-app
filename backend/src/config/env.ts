import 'dotenv/config';
import { z } from 'zod';

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().trim().min(1).optional(),
    JWT_SECRET: optionalSecret,
    JWT_REFRESH_SECRET: optionalSecret,
    PORT: z.coerce.number().int().positive().default(5000),
    OCR_SPACE_API_KEY: optionalSecret,
    CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  })
  .superRefine((values, context) => {
    if (values.NODE_ENV !== 'test' && !values.DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required outside the test environment.',
      });
    }

    if (values.NODE_ENV === 'production') {
      for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
        if (!values[key]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required in production.`,
          });
        }
      }
    }
  });

export const env = envSchema.parse(process.env);
