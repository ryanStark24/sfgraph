export const ErrorCode = {
  READ_ONLY_VIOLATION: "READ_ONLY_VIOLATION",
  CONFIG: "CONFIG",
  STORAGE: "STORAGE",
  MIGRATION: "MIGRATION",
  TELEMETRY: "TELEMETRY",
  VALIDATION: "VALIDATION",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class SfgraphError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SfgraphError";
  }
}

export class ReadOnlyViolationError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.READ_ONLY_VIOLATION, message, options);
    this.name = "ReadOnlyViolationError";
  }
}

export class ConfigError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.CONFIG, message, options);
    this.name = "ConfigError";
  }
}

export class StorageError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.STORAGE, message, options);
    this.name = "StorageError";
  }
}

export class MigrationError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.MIGRATION, message, options);
    this.name = "MigrationError";
  }
}

export class TelemetryError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.TELEMETRY, message, options);
    this.name = "TelemetryError";
  }
}

export class ValidationError extends SfgraphError {
  constructor(message: string, options?: ErrorOptions) {
    super(ErrorCode.VALIDATION, message, options);
    this.name = "ValidationError";
  }
}
