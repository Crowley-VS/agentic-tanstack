// One line per event, for the web server and the API. In production each line is one JSON object:
// Railway (like most log platforms) parses it, shows `message`, colors it by `level`, and makes
// every other field a filter (`@requestId:<id>`, `@status:500`). In development it is a readable
// text line. Server code only (the web app imports it from *.server.ts files).
//
// No dependencies, on purpose: pino would add 11 packages and 126 kB to each server bundle, and
// its worker-thread transports (pino-pretty) do not survive bundling; these servers need lines,
// not a logging framework.
import { inspect } from 'node:util';

export type Level = 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'text';

/**
 * A line's extra fields (JSON attributes, `key=value` in text). `err` takes an Error, written
 * with its stack and causes. Fields never replace the line's own keys (time, level, message…).
 */
export type Fields = Record<string, unknown>;

/** What a server logs once per request it answers. */
export type RequestLine = {
  method: string;
  path: string;
  status: number;
  /** Milliseconds until the response started (its status and headers). */
  ms: number;
  /** The client's IP, when the server knows it (the API: only when the web server sends it). */
  ip?: string;
  /** Ties together the web server's and the API's lines for one browser request. */
  requestId?: string;
};

export type Logger = {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** One line per answered request: level `error` for a 5xx, else `info`. */
  request(line: RequestLine): void;
};

export type LoggerOptions = {
  /**
   * `web` or `api`: every JSON line's `app`, and the text line's prefix. Not `service`: Railway's
   * own log filter `@service:<id>` names its services by id.
   */
  app: string;
  format: LogFormat;
  /** APP_VERSION: in every JSON line, so a line says which deploy wrote it. */
  version?: string;
  /** Where a finished line goes (tests collect them); by default the console, see below. */
  write?: (line: string, level: Level) => void;
  /** The clock (tests fix it). */
  now?: () => Date;
};

/** LOG_FORMAT (`json` or `text`) when set to one of them; else JSON in production, else text. */
export function logFormat(env: { LOG_FORMAT?: string; NODE_ENV?: string }): LogFormat {
  if (env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'text') return env.LOG_FORMAT;
  return env.NODE_ENV === 'production' ? 'json' : 'text';
}

/**
 * The default `write`: JSON lines all go to stdout, since a platform reads the level from the line
 * (Railway marks every stderr line an error, whatever it says). Text lines go where a terminal
 * user expects them. Exported for a `write` that changes a line before it goes out.
 */
export function consoleWriter(format: LogFormat): (line: string, level: Level) => void {
  return (line: string, level: Level) => {
    if (format === 'text' && level !== 'info') console.error(line);
    else console.log(line);
  };
}

/**
 * What an error wraps: its `cause`, else the error a GraphQLError wraps. graphql-js keeps what a
 * resolver threw on `originalError` (not enumerable, not `cause`): for a failed query a
 * DrizzleQueryError, whose own cause is the driver's error (ECONNREFUSED, a Postgres error).
 */
function wrappedBy(err: Error): unknown {
  if (err.cause !== undefined) return err.cause;
  const original: unknown = Reflect.get(err, 'originalError');
  return original instanceof Error ? original : undefined;
}

/** An error as JSON: name, message, stack, and what it wraps (three deep). */
function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) return typeof err === 'string' ? err : inspect(err);
  const inner = depth < 3 ? wrappedBy(err) : undefined;
  // a GraphQLError takes the stack of the error it wraps: written once, there
  const stack = inner instanceof Error && inner.stack === err.stack ? undefined : err.stack;
  const cause = inner === undefined ? {} : { cause: serializeError(inner, depth + 1) };
  return { name: err.name, message: err.message, stack, ...cause };
}

/** `key=value`, quoted when the value has spaces or quotes; nothing for an undefined value. */
function textField(key: string, value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return ` ${key}=${/^[^\s"=]*$/.test(text) && text !== '' ? text : JSON.stringify(text)}`;
}

export function createLogger({
  app,
  format,
  version,
  write = consoleWriter(format),
  now = () => new Date(),
}: LoggerOptions): Logger {
  function json(level: Level, message: string, fields: Fields): string {
    const base = { time: now().toISOString(), level, app, version, message };
    const line: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(fields))
      if (!(key in base)) line[key] = key === 'err' ? serializeError(value) : value;
    try {
      return JSON.stringify(line);
    } catch (error) {
      // a field JSON cannot hold (a BigInt, a cycle): keep the line, say why its fields are missing
      return JSON.stringify({ ...base, logError: String(error) });
    }
  }

  function text(message: string, fields: Fields): string {
    const { err, ...rest } = fields;
    const pairs = Object.entries(rest)
      .map(([key, value]) => textField(key, value))
      .join('');
    return `[${app}] ${message}${pairs}${err === undefined ? '' : `\n${inspect(err)}`}`;
  }

  const line =
    (level: Level) =>
    (message: string, fields: Fields = {}) =>
      write(format === 'json' ? json(level, message, fields) : text(message, fields), level);
  const info = line('info');
  const warn = line('warn');
  const error = line('error');

  return {
    info,
    warn,
    error,
    request({ method, path, status, ms, ip, requestId }) {
      const level: Level = status >= 500 ? 'error' : 'info';
      const message = `${status} ${method} ${path} ${ms}ms`;
      // the text line keeps the shape agents and people grep for: `... ip=<ip> id=<request id>`
      if (format === 'text')
        write(`[${app}] ${message} ip=${ip ?? '-'} id=${requestId ?? '-'}`, level);
      else write(json(level, message, { requestId, method, path, status, ms, ip }), level);
    },
  };
}
