import sharp from "sharp";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { readdir, mkdir, unlink, stat, rm } from "node:fs/promises";
import { join, extname, basename } from "node:path";

// create new database files if they don't exist
if (!(await Bun.file("database.json").exists())) {
  await Bun.write("database.json", "[]");
}
if (!(await Bun.file("database_bulk.json").exists())) {
  await Bun.write("database_bulk.json", "[]");
}

const PORT = process.env.PORT || 3000;
const ROOT = import.meta.dir;
const INPUT_DIR = join(ROOT, "input");
const OUTPUT_DIR = join(ROOT, "output");
const BULK_DIR = join(ROOT, "bulk");
const DB_PATH = join(ROOT, "database.json");
const BULK_DB_PATH = join(ROOT, "database_bulk.json");
const PUBLIC_DIR = join(ROOT, "public");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 100;

// Ensure directories exist
await mkdir(INPUT_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(BULK_DIR, { recursive: true });

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

async function readBulkDB(): Promise<any[]> {
  const file = Bun.file(BULK_DB_PATH);
  if (await file.exists()) {
    return file.json();
  }
  return [];
}

async function writeBulkDB(data: any[]) {
  await Bun.write(BULK_DB_PATH, JSON.stringify(data, null, 2));
}

// ── SSE Event Emitter ────────────────────────────────────────────────────────

type SSEListener = (event: string, data: any) => void;
const sseListeners = new Map<string, Set<SSEListener>>();

function emitSSE(taskId: string, event: string, data: any) {
  const listeners = sseListeners.get(taskId);
  if (listeners) {
    for (const listener of listeners) {
      listener(event, data);
    }
  }
}

function addSSEListener(taskId: string, listener: SSEListener) {
  if (!sseListeners.has(taskId)) {
    sseListeners.set(taskId, new Set());
  }
  sseListeners.get(taskId)!.add(listener);
}

function removeSSEListener(taskId: string, listener: SSEListener) {
  const listeners = sseListeners.get(taskId);
  if (listeners) {
    listeners.delete(listener);
    if (listeners.size === 0) sseListeners.delete(taskId);
  }
}

// ── Bulk Processing ──────────────────────────────────────────────────────────

async function processBulkTask(
  taskId: string,
  files: { name: string; buffer: Buffer; originalSize: number }[],
  scale: number,
  quality: number
) {
  const taskDir = join(BULK_DIR, taskId);
  await mkdir(taskDir, { recursive: true });

  const totalCount = files.length;
  let processedCount = 0;

  try {
    // Process each image
    for (const file of files) {
      const baseName = basename(file.name, extname(file.name));
      let pipeline = sharp(file.buffer);
      const metadata = await sharp(file.buffer).metadata();

      const newWidth = Math.round((metadata.width || 800) * (scale / 100));
      pipeline = pipeline.resize({ width: newWidth }).webp({ quality });

      const outputBuffer = await pipeline.toBuffer();
      await Bun.write(join(taskDir, `${baseName}.webp`), outputBuffer);

      processedCount++;
      const progress = Math.round((processedCount / totalCount) * 100);

      // Update DB
      const db = await readBulkDB();
      const task = db.find((t) => t.id === taskId);
      if (task) {
        task.processedCount = processedCount;
        task.progress = progress;
        await writeBulkDB(db);
      }

      // Emit SSE
      emitSSE(taskId, "progress", {
        processedCount,
        totalCount,
        progress,
        currentFile: file.name,
      });
    }

    // Create zip
    const zipFilename = `bulk-${taskId}.zip`;
    const zipPath = join(BULK_DIR, zipFilename);

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(taskDir, false);
      archive.finalize();
    });

    const zipStat = await stat(zipPath);
    const zipSize = zipStat.size;

    // Update DB as completed
    const db = await readBulkDB();
    const task = db.find((t) => t.id === taskId);
    if (task) {
      task.status = "completed";
      task.progress = 100;
      task.processedCount = totalCount;
      task.zipFilename = zipFilename;
      task.zipSize = zipSize;
      task.completedAt = new Date().toISOString();
      await writeBulkDB(db);
    }

    emitSSE(taskId, "completed", {
      zipFilename,
      zipSize,
      totalInputSize: files.reduce((sum, f) => sum + f.originalSize, 0),
    });

    // Cleanup temp processed dir (zip is ready)
    await rm(taskDir, { recursive: true, force: true });
  } catch (err: any) {
    console.error(`[Bulk] Task ${taskId} failed:`, err);

    const db = await readBulkDB();
    const task = db.find((t) => t.id === taskId);
    if (task) {
      task.status = "failed";
      task.error = err.message || "Processing failed";
      await writeBulkDB(db);
    }

    emitSSE(taskId, "error", { error: err.message || "Processing failed" });

    // Cleanup on failure
    await rm(taskDir, { recursive: true, force: true }).catch(() => {});
  }
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
  ".zip": "application/zip",
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

    // ── POST /bulk-optimise ────────────────────────────────────────────────
    if (req.method === "POST" && path === "/bulk-optimise") {
      try {
        const formData = await req.formData();
        const scaleStr = formData.get("scale") as string | null;
        const qualityStr = formData.get("quality") as string | null;
        const scale = scaleStr ? Math.min(100, Math.max(10, parseInt(scaleStr, 10))) : 50;
        const quality = qualityStr ? Math.min(100, Math.max(50, parseInt(qualityStr, 10))) : 70;

        // Collect all files
        const imageFiles: { name: string; buffer: Buffer; originalSize: number }[] = [];
        for (const [key, value] of formData.entries()) {
          if (key === "images" && value instanceof File) {
            if (value.size > MAX_FILE_SIZE) {
              return jsonResponse(
                { error: `File "${value.name}" exceeds 10 MB limit (${(value.size / 1024 / 1024).toFixed(1)} MB)` },
                400
              );
            }
            imageFiles.push({
              name: value.name || "upload.jpg",
              buffer: Buffer.from(await value.arrayBuffer()),
              originalSize: value.size,
            });
          }
        }

        if (imageFiles.length === 0) {
          return jsonResponse({ error: "No images provided" }, 400);
        }
        if (imageFiles.length > MAX_FILES) {
          return jsonResponse({ error: `Maximum ${MAX_FILES} files allowed per batch` }, 400);
        }

        const taskId = crypto.randomUUID();
        const totalInputSize = imageFiles.reduce((sum, f) => sum + f.originalSize, 0);

        // Create task entry
        const task = {
          id: taskId,
          status: "processing",
          progress: 0,
          files: imageFiles.map((f) => ({ name: f.name, originalSize: f.originalSize })),
          totalInputSize,
          processedCount: 0,
          totalCount: imageFiles.length,
          zipFilename: null,
          zipSize: null,
          scale,
          quality,
          ip: clientIP,
          createdAt: new Date().toISOString(),
          completedAt: null,
          error: null,
        };

        const db = await readBulkDB();
        db.unshift(task);
        await writeBulkDB(db);

        // Start async processing (fire-and-forget)
        processBulkTask(taskId, imageFiles, scale, quality);

        return jsonResponse({ taskId });
      } catch (err: any) {
        console.error("Bulk upload error:", err);
        return jsonResponse({ error: err.message || "Upload failed" }, 500);
      }
    }

    // ── GET /bulk-events/:taskId ───────────────────────────────────────────
    if (req.method === "GET" && path.startsWith("/bulk-events/")) {
      const taskId = path.replace("/bulk-events/", "");

      const db = await readBulkDB();
      const task = db.find((t) => t.id === taskId);
      if (!task) {
        return jsonResponse({ error: "Task not found" }, 404);
      }

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const send = (event: string, data: any) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          // Send current state immediately
          send("status", {
            status: task.status,
            progress: task.progress,
            processedCount: task.processedCount,
            totalCount: task.totalCount,
            zipFilename: task.zipFilename,
            zipSize: task.zipSize,
            totalInputSize: task.totalInputSize,
          });

          // If already done, close the stream
          if (task.status === "completed" || task.status === "failed") {
            controller.close();
            return;
          }

          // Listen for future events
          const listener: SSEListener = (event, data) => {
            try {
              send(event, data);
              if (event === "completed" || event === "error") {
                removeSSEListener(taskId, listener);
                controller.close();
              }
            } catch {
              removeSSEListener(taskId, listener);
            }
          };

          addSSEListener(taskId, listener);

          // Heartbeat to keep connection alive
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeat);
              removeSSEListener(taskId, listener);
            }
          }, 15000);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // ── GET /bulk-status/:taskId ───────────────────────────────────────────
    if (req.method === "GET" && path.startsWith("/bulk-status/")) {
      const taskId = path.replace("/bulk-status/", "");
      const db = await readBulkDB();
      const task = db.find((t) => t.id === taskId);
      if (!task) return jsonResponse({ error: "Task not found" }, 404);
      return jsonResponse(task);
    }

    // ── GET /bulk-download/:taskId ─────────────────────────────────────────
    if (req.method === "GET" && path.startsWith("/bulk-download/")) {
      const taskId = path.replace("/bulk-download/", "");
      const db = await readBulkDB();
      const task = db.find((t) => t.id === taskId);
      if (!task || task.status !== "completed" || !task.zipFilename) {
        return jsonResponse({ error: "Download not available" }, 404);
      }
      const zipPath = join(BULK_DIR, task.zipFilename);
      const zipFile = Bun.file(zipPath);
      if (!(await zipFile.exists())) {
        return jsonResponse({ error: "Zip file not found" }, 404);
      }
      return new Response(zipFile, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${task.zipFilename}"`,
          ...corsHeaders(),
        },
      });
    }

    // ── GET /bulk-history ──────────────────────────────────────────────────
    if (req.method === "GET" && path === "/bulk-history") {
      const db = await readBulkDB();
      const userHistory = db.filter((entry) => entry.ip === clientIP);
      return jsonResponse(userHistory);
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

  // Clean bulk/ directory (zip files)
  try {
    const bulkFiles = await readdir(BULK_DIR);
    for (const file of bulkFiles) {
      if (file === ".gitkeep") continue;
      const filePath = join(BULK_DIR, file);
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > TWENTY_FOUR_HOURS) {
        if (fileStat.isDirectory()) {
          await rm(filePath, { recursive: true, force: true });
        } else {
          await unlink(filePath);
        }
        console.log(`[Cron] Deleted bulk: ${filePath}`);
      }
    }
  } catch (err) {
    console.error("[Cron] Error cleaning bulk dir:", err);
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

  // Clean bulk database entries older than 24h
  try {
    const bulkDb = await readBulkDB();
    const filtered = bulkDb.filter(
      (entry) => now - new Date(entry.createdAt).getTime() <= TWENTY_FOUR_HOURS
    );
    if (filtered.length !== bulkDb.length) {
      console.log(`[Cron] Removed ${bulkDb.length - filtered.length} old bulk DB entries`);
      await writeBulkDB(filtered);
    }
  } catch (err) {
    console.error("[Cron] Error cleaning bulk database:", err);
  }

  // Clear stale rate limits
  rateLimitMap.clear();
  console.log("[Cron] Rate limits reset");
}

// Run every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);
console.log("⏰ Cleanup scheduled (every hour, removes files > 24h old)");
