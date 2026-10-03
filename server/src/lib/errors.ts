export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
export const invalid = (message: string, details?: unknown) =>
  new AppError('VALIDATION', 422, message, details);
