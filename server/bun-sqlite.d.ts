/**
 * Minimal ambient types for `bun:sqlite`, which `server/db.ts` imports only when
 * GECKO runs under Bun.
 *
 * Declared locally rather than pulling in `@types/bun`, which would add a
 * dependency for a runtime the project does not require. Delete this file if
 * `@types/bun` is ever added.
 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
    };
    query(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
    };
    exec(sql: string): void;
    transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
    close(): void;
  }
}
