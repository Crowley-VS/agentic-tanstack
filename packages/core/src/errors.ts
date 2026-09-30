/** A referenced record does not exist. The API maps it to its NotFoundError result type. */
export class NotFoundError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

/** The Postgres error code of a driver error, however deeply drizzle wrapped it. */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export const PG_FOREIGN_KEY_VIOLATION = '23503';
