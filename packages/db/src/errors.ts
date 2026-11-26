export type DomainErrorCode = "not_found" | "conflict" | "invalid";

/** Expected, user-facing failures. The API maps code → HTTP status. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
