import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

function toText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const idx = line.indexOf("=");
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

function loadEnvMap(explicitEnvFile?: string): {
  env: Record<string, string>;
  envPathUsed?: string;
} {
  const cwd = process.cwd();

  const candidates = explicitEnvFile
    ? [explicitEnvFile]
    : [
        process.env.DB_ENV_FILE,
        ".env",
        "shop/source/.env",
        "source/.env",
      ].filter((v): v is string => Boolean(v));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.join(cwd, candidate);

    if (!fs.existsSync(resolved)) continue;

    const content = fs.readFileSync(resolved, "utf-8");
    return { env: parseEnvContent(content), envPathUsed: resolved };
  }

  return { env: {}, envPathUsed: undefined };
}

function firstDefined(
  sources: Array<Record<string, string> | NodeJS.ProcessEnv>,
  keys: string[],
): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

function loadDbConfig(explicitEnvFile?: string): DbConfig & { envPathUsed?: string } {
  const { env, envPathUsed } = loadEnvMap(explicitEnvFile);

  // Process env overrides file values so you can easily "export ..." for testing.
  const sources = [process.env, env];

  const host = firstDefined(sources, ["DB_HOST"]) ?? "localhost";
  const portRaw = firstDefined(sources, ["DB_PORT"]);
  const database = firstDefined(sources, ["DB_NAME", "DB_DATABASE"]);
  const user = firstDefined(sources, ["DB_USER", "DB_USERNAME"]);
  const password = firstDefined(sources, ["DB_PASSWORD"]);

  if (!database) throw new Error("Missing DB_NAME/DB_DATABASE (env or .env)");
  if (!user) throw new Error("Missing DB_USER/DB_USERNAME (env or .env)");
  if (password === undefined) throw new Error("Missing DB_PASSWORD (env or .env)");

  const port = portRaw ? Number(portRaw) : 3306;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid DB_PORT: ${portRaw}`);
  }

  return {
    host,
    port,
    database,
    user,
    password,
    envPathUsed,
  };
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

function normalizeSingleStatement(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error("Query is empty");

  // Allow one optional trailing semicolon, reject anything else.
  const withoutTrailing = trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
  if (withoutTrailing.includes(";")) {
    throw new Error("Only a single SQL statement is allowed per call");
  }

  return withoutTrailing;
}

function ensureReadOnlyPolicy(sql: string, maxRows: number): {
  sql: string;
  statementType: string;
  limitWasAutoAdded: boolean;
} {
  const single = normalizeSingleStatement(sql);
  const noComments = stripSqlComments(single);

  const firstWordMatch = noComments.match(/^\s*([a-zA-Z_]+)/);
  const statementType = (firstWordMatch?.[1] ?? "").toLowerCase();

  const allowedStart = new Set(["select", "show", "describe", "desc", "explain", "with"]);
  if (!allowedStart.has(statementType)) {
    throw new Error(
      `Only read-only statements are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN). Got: ${statementType || "unknown"}`,
    );
  }

  const forbidden = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|lock|unlock)\b/i;
  if (forbidden.test(noComments)) {
    throw new Error("Query contains write/DDL keywords and is not allowed in read-only mode");
  }

  // LIMIT parser (simple but practical)
  // Supports: LIMIT n, LIMIT offset,n, LIMIT n OFFSET offset
  const limitMatch = noComments.match(/\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?\b/i);

  const isSelectLike = /^(select|with)\b/i.test(noComments.trim());
  if (!isSelectLike) {
    return { sql: single, statementType, limitWasAutoAdded: false };
  }

  if (!limitMatch) {
    return {
      sql: `${single} LIMIT ${maxRows}`,
      statementType,
      limitWasAutoAdded: true,
    };
  }

  const first = Number(limitMatch[1]);
  const second = limitMatch[2] ? Number(limitMatch[2]) : undefined;
  const count = Number.isFinite(second) ? second! : first;

  if (count > maxRows) {
    throw new Error(`LIMIT ${count} exceeds maxRows=${maxRows}`);
  }

  return { sql: single, statementType, limitWasAutoAdded: false };
}

export default function bfShopDbQueryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "bf_shop_db_query",
    label: "BF Shop DB Query",
    description:
      "Execute a read-only MySQL query using DB_* values from .env (or exported environment variables). " +
      "SELECT queries are auto-limited to maxRows when LIMIT is missing.",

    parameters: Type.Object({
      query: Type.String({
        description:
          "Single SQL statement. Allowed: SELECT/SHOW/DESCRIBE/EXPLAIN. Multi-statement input is rejected.",
      }),
      params: Type.Optional(
        Type.Array(Type.Any(), {
          description: "Optional bind parameters for ? placeholders",
        }),
      ),
      envFile: Type.Optional(
        Type.String({
          description:
            "Optional path to .env file (absolute or relative to current project directory). If omitted, tries DB_ENV_FILE, .env, shop/source/.env, source/.env",
        }),
      ),
      maxRows: Type.Optional(
        Type.Number({
          description: "Maximum allowed LIMIT for SELECT-like queries (default 10)",
          default: 10,
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "Optional reason for the query (returned in metadata)",
        }),
      ),
    }),

    async execute(
      _toolCallId,
      params: {
        query: string;
        params?: unknown[];
        envFile?: string;
        maxRows?: number;
        reason?: string;
      },
    ) {
      try {
        const maxRows = Number.isFinite(params.maxRows) && (params.maxRows ?? 0) > 0
          ? Math.floor(params.maxRows!)
          : 10;

        const db = loadDbConfig(params.envFile);
        const policy = ensureReadOnlyPolicy(params.query, maxRows);

        let mysqlMod: any;
        try {
          mysqlMod = await import("mysql2/promise");
        } catch {
          throw new Error(
            "Missing dependency mysql2. Install it in ~/.pi/agent (or your package): npm install mysql2",
          );
        }

        const mysql = mysqlMod.default ?? mysqlMod;
        const conn = await mysql.createConnection({
          host: db.host,
          port: db.port,
          user: db.user,
          password: db.password,
          database: db.database,
          connectTimeout: 10_000,
          multipleStatements: false,
        });

        try {
          const hasParams = Array.isArray(params.params) && params.params.length > 0;
          const [rawRows, fields] = hasParams
            ? await conn.execute(policy.sql, params.params)
            : await conn.query(policy.sql);

          const isResultSet = Array.isArray(rawRows);
          const rows = isResultSet ? rawRows : [];
          const rowCount = isResultSet
            ? rows.length
            : Number((rawRows as { affectedRows?: number })?.affectedRows ?? 0);

          const columns = Array.isArray(fields)
            ? fields.map((f: { name?: string; type?: unknown }) => ({
                name: f.name ?? "",
                ...(f.type !== undefined ? { type: String(f.type) } : {}),
              }))
            : [];

          const result = {
            ok: true,
            data: {
              rows,
              rowCount,
              columns,
            },
            meta: {
              statementType: policy.statementType,
              limitWasAutoAdded: policy.limitWasAutoAdded,
              maxRows,
              cwd: process.cwd(),
              envPathUsed: db.envPathUsed ?? null,
              ...(params.reason ? { reason: params.reason } : {}),
            },
          };

          return {
            content: [{ type: "text", text: toText(result) }],
            details: result,
          };
        } finally {
          await conn.end();
        }
      } catch (error) {
        const result = {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };

        return {
          content: [{ type: "text", text: toText(result) }],
          details: result,
        };
      }
    },
  });
}
