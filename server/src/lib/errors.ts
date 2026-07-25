export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly data: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  httpStatus = 400,
  data: Record<string, unknown> | null = null,
): asserts condition {
  if (!condition) throw new AppError(code, message, httpStatus, data);
}
