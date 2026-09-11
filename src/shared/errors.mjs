export class CompanionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CompanionError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function normalizeError(error, fallbackCode = "internal_error") {
  if (error instanceof CompanionError) {
    return error.toJSON();
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

