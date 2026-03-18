import sharp from "sharp";
import { readdir, mkdir, unlink, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";

// create new database.json file if it doesn't exist
if (!(await Bun.file("database.json").exists())) {
  await Bun.write("database.json", "[]");
}

const PORT = process.env.PORT || 3000;
const ROOT = import.meta.dir;
const INPUT_DIR = join(ROOT, "input");
const OUTPUT_DIR = join(ROOT, "output");
const DB_PATH = join(ROOT, "database.json");
const PUBLIC_DIR = join(ROOT, "public");

// Ensure directories exist
await mkdir(INPUT_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

// ── Rate Limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT = 5;
const rateLimitMap = new Map<string, number>();

function getClientIP(req: Request, server: any): string {
  // Bun.serve provides socketAddress; fall back to headers for proxied setups
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return server.requestIP(req)?.address || "unknown";
}

function checkRateLimit(ip: string): boolean {
  const count = rateLimitMap.get(ip) || 0;
  return count < RATE_LIMIT;
}

function incrementRateLimit(ip: string) {
  const count = rateLimitMap.get(ip) || 0;
  rateLimitMap.set(ip, count + 1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readDB(): Promise<any[]> {
  const file = Bun.file(DB_PATH);
  if (await file.exists()) {
    return file.json();
  }
  return [];
}

async function writeDB(data: any[]) {
  await Bun.write(DB_PATH, JSON.stringify(data, null, 2));
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ── Mime lookup ──────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

// ── Server ───────────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    const clientIP = getClientIP(req, server);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── POST /optimise ─────────────────────────────────────────────────────
    if (req.method === "POST" && path === "/optimise") {
      // Rate limit check
      if (!checkRateLimit(clientIP)) {
        return jsonResponse({ error: "Rate limit exceeded. Maximum 5 images allowed." }, 429);
      }

      try {
        const formData = await req.formData();
        const file = formData.get("image") as File | null;
        const mode = (formData.get("mode") as string) || "webp";
        const scaleStr = formData.get("scale") as string | null;
        const scale = scaleStr ? parseInt(scaleStr, 10) : 50;

        if (!file) {
          return jsonResponse({ error: "No image provided" }, 400);
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const timestamp = Date.now();
        const originalName = file.name || "upload.jpg";
        const baseName = basename(originalName, extname(originalName));

        // Save original to input/
        const inputFilename = `${timestamp}-${originalName}`;
        await Bun.write(join(INPUT_DIR, inputFilename), buffer);

        // Process with Sharp
        let pipeline = sharp(buffer);
        const metadata = await sharp(buffer).metadata();
        let outputExt = extname(originalName);
        let contentType = file.type || "image/jpeg";

        if (mode === "webp") {
          pipeline = pipeline.webp({ quality: 70 });
          outputExt = ".webp";
          contentType = "image/webp";
        } else if (mode === "resize") {
          const newWidth = Math.round((metadata.width || 800) * (scale / 100));
          pipeline = pipeline.resize({ width: newWidth });
        } else if (mode === "resize-and-optimise") {
          const newWidth = Math.round((metadata.width || 800) * (scale / 100));
          pipeline = pipeline.resize({ width: newWidth }).webp({ quality: 70 });
          outputExt = ".webp";
          contentType = "image/webp";
        }

        const outputBuffer = await pipeline.toBuffer();

        // Save optimised to output/
        const outputFilename = `${timestamp}-${baseName}${outputExt}`;
        await Bun.write(join(OUTPUT_DIR, outputFilename), outputBuffer);

        // Update database
        const db = await readDB();
        db.unshift({
          id: String(timestamp),
          originalName,
          originalSize: buffer.length,
          optimisedSize: outputBuffer.length,
          mode,
          scale: mode === "webp" ? null : scale,
          outputFilename,
          ip: clientIP,
          timestamp: new Date(timestamp).toISOString(),
        });
        await writeDB(db);

        // Increment rate limit after successful processing
        incrementRateLimit(clientIP);

        return new Response(outputBuffer, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${outputFilename}"`,
            "X-Original-Size": String(buffer.length),
            "X-Optimised-Size": String(outputBuffer.length),
            ...corsHeaders(),
          },
        });
      } catch (err: any) {
        console.error("Optimise error:", err);
        return jsonResponse({ error: err.message || "Processing failed" }, 500);
      }
    }

    // ── GET /history ───────────────────────────────────────────────────────
    if (req.method === "GET" && path === "/history") {
      const db = await readDB();
      const userHistory = db.filter((entry) => entry.ip === clientIP);
      return jsonResponse(userHistory);
    }

    // ── GET /output/:filename ──────────────────────────────────────────────
    if (req.method === "GET" && path.startsWith("/output/")) {
      const filename = path.replace("/output/", "");
      const filePath = join(OUTPUT_DIR, filename);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const ext = extname(filename);
        return new Response(file, {
          headers: {
            "Content-Type": MIME[ext] || "application/octet-stream",
            ...corsHeaders(),
          },
        });
      }
      return jsonResponse({ error: "File not found" }, 404);
    }

    // ── Static files (public/) ─────────────────────────────────────────────
    let filePath = path === "/" ? "/index.html" : path;
    const fullPath = join(PUBLIC_DIR, filePath);
    const staticFile = Bun.file(fullPath);

    if (await staticFile.exists()) {
      const ext = extname(fullPath);
      return new Response(staticFile, {
        headers: {
          "Content-Type": MIME[ext] || "application/octet-stream",
          ...corsHeaders(),
        },
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
});

console.log(`🖼️  Image Optimizer running at ${PORT}`);

// ── Cron: cleanup files older than 24 hours ──────────────────────────────────

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

async function cleanupOldFiles() {
  const now = Date.now();
  console.log(`[Cron] Running 24h cleanup at ${new Date(now).toISOString()}`);

  // Clean input/ and output/ directories
  for (const dir of [INPUT_DIR, OUTPUT_DIR]) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (file === ".gitkeep") continue;
        const filePath = join(dir, file);
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > TWENTY_FOUR_HOURS) {
          await unlink(filePath);
          console.log(`[Cron] Deleted: ${filePath}`);
        }
      }
    } catch (err) {
      console.error(`[Cron] Error cleaning ${dir}:`, err);
    }
  }

  // Clean database entries older than 24h
  try {
    const db = await readDB();
    const filtered = db.filter(
      (entry) => now - new Date(entry.timestamp).getTime() <= TWENTY_FOUR_HOURS
    );
    if (filtered.length !== db.length) {
      console.log(`[Cron] Removed ${db.length - filtered.length} old DB entries`);
      await writeDB(filtered);
    }
  } catch (err) {
    console.error("[Cron] Error cleaning database:", err);
  }

  // Clear stale rate limits
  rateLimitMap.clear();
  console.log("[Cron] Rate limits reset");
}

// Run every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);
console.log("⏰ Cleanup scheduled (every hour, removes files > 24h old)");
