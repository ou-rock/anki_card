export class SymphonyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SymphonyError";
    this.code = code;
    this.details = details;
  }
}

export function asErrorMessage(error) {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  return String(error);
}
