export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const notFound = (message: string) => new HttpError(404, 'not_found', message);
export const unauthorized = (message: string) => new HttpError(401, 'unauthorized', message);
