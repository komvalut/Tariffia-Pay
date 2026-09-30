export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = 'request_error') {
    super(message);
    this.name = 'HttpError';
  }
}
