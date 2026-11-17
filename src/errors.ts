export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details);

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'validation_failed', message, details);
