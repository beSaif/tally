import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { ApiErrorBody, ErrorCode } from '@shared/api';
import type { AppEnv } from '../env';

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  validation: 400,
  not_found: 404,
  rate_limited: 429,
  forbidden: 403,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message?: string, status?: number) {
    super(message ?? code);
    this.code = code;
    this.status = status ?? STATUS[code];
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (what = 'Not found') => new ApiError('not_found', what);
export const unauthorized = () => new ApiError('unauthorized', 'Not signed in');
export const validation = (message: string) => new ApiError('validation', message);

/** Parses and validates a JSON body. Requires a JSON content type (part of the CSRF story). */
export async function readJson<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const ct = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw validation('Expected application/json');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw validation('Body is not valid JSON');
  }
  return validate(schema, raw);
}

export function readQuery<T>(c: Context<AppEnv>, schema: ZodType<T>): T {
  return validate(schema, c.req.query());
}

export function validate<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.map(String).join('.')}: ` : '';
    throw validation(`${path}${issue?.message ?? 'invalid input'}`);
  }
  return result.data;
}

/** Hono `onError` handler: ApiError → its JSON; anything else → 500 (logged). */
export function handleError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  const body: ApiErrorBody = { error: { code: 'internal', message: 'Something went wrong' } };
  return c.json(body, 500);
}
