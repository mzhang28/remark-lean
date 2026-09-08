import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

export const CACHE_VERSION = "v10-output-marker";

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

interface LakeManifest {
  packages?: Array<{
    name?: string;
    dir?: string;
    rev?: string;
  }>;
}

function collectLeanFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".lake" || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLeanFiles(fullPath, results);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".lean") &&
      !entry.name.startsWith("__temp_lean_highlight_")
    ) {
      results.push(fullPath);
    }
  }

  return results;
}

function hashLeanDirectory(dir: string): string {
  const files = collectLeanFiles(dir).sort();
  const parts: string[] = [];

  for (const file of files) {
    const rel = path.relative(dir, file);
    const content = fs.readFileSync(file, "utf8");
    parts.push(`${rel}\0${content}`);
  }

  return hashContent(parts.join("\n"));
}

/** Fingerprint a Lean project and its dependencies for cache invalidation. */
export function computeProjectFingerprint(projectPath: string): string {
  const parts: string[] = [hashLeanDirectory(projectPath)];

  const manifestPath = path.join(projectPath, "lake-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return hashContent(parts.join("\n"));
  }

  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  parts.push(manifestRaw);

  try {
    const manifest: LakeManifest = JSON.parse(manifestRaw);
    for (const pkg of manifest.packages ?? []) {
      if (pkg.rev) {
        parts.push(`${pkg.name ?? ""}:${pkg.rev}`);
      }
      if (pkg.dir) {
        parts.push(`${pkg.name ?? ""}:${hashLeanDirectory(path.resolve(pkg.dir))}`);
      }
    }
  } catch {
    // Ignore malformed manifests and fall back to the raw file contents above.
  }

  return hashContent(parts.join("\n"));
}

const dbMap = new Map<string, Client>();
const dbInitMap = new Map<string, Promise<void>>();

function getDatabase(customCacheDir?: string): Client {
  const cacheDir = customCacheDir
    ? path.resolve(process.cwd(), customCacheDir)
    : path.resolve(process.cwd(), "node_modules", ".cache", "leandown");

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const dbPath = path.join(cacheDir, "cache.db");
  const dbUrl = `file:${dbPath}`;
  
  let db = dbMap.get(dbPath);
  if (!db) {
    db = createClient({ url: dbUrl });
    dbMap.set(dbPath, db);
  }
  return db;
}

async function ensureDatabaseInitialized(customCacheDir?: string): Promise<Client> {
  const cacheDir = customCacheDir
    ? path.resolve(process.cwd(), customCacheDir)
    : path.resolve(process.cwd(), "node_modules", ".cache", "leandown");
  const dbPath = path.join(cacheDir, "cache.db");

  const db = getDatabase(customCacheDir);

  let initPromise = dbInitMap.get(dbPath);
  if (!initPromise) {
    initPromise = (async () => {
      await db.execute("PRAGMA journal_mode = WAL;");
      await db.execute("CREATE TABLE IF NOT EXISTS highlight_cache (key TEXT PRIMARY KEY, html TEXT);");
    })();
    dbInitMap.set(dbPath, initPromise);
  }
  await initPromise;
  return db;
}

export async function getCachedHighlight(hash: string, customCacheDir?: string): Promise<string | null> {
  const db = await ensureDatabaseInitialized(customCacheDir);
  const result = await db.execute({
    sql: "SELECT html FROM highlight_cache WHERE key = ?",
    args: [hash]
  });
  const row = result.rows[0];
  if (row) {
    return row.html as string;
  }
  return null;
}

export async function setCachedHighlight(hash: string, html: string, customCacheDir?: string): Promise<void> {
  const db = await ensureDatabaseInitialized(customCacheDir);
  await db.execute({
    sql: "INSERT OR REPLACE INTO highlight_cache (key, html) VALUES (?, ?)",
    args: [hash, html]
  });
}
