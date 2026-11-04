import { ConflictException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

/** Errors carry a stable machine-readable code (shown by the dashboard), like the controller's 409s. */
export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ statusCode: 409, code, message });
}

export function unprocessable(code: string, message: string, details?: unknown): UnprocessableEntityException {
  return new UnprocessableEntityException({ statusCode: 422, code, message, ...(details !== undefined ? { details } : {}) });
}

export function notFound(what: string, id: string): NotFoundException {
  return new NotFoundException({ statusCode: 404, code: 'NOT_FOUND', message: `${what} ${id} not found` });
}

export function unavailable(code: string, message: string, status = 503): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** JSON columns: tolerate corrupt values instead of failing a whole listing. */
export function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
