# Image Optimizer — Knowledge Base

## Stack

- **Runtime**: Bun
- **Image processing**: Sharp.js
- **Zip**: Archiver
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Database**: Flat JSON files (`database.json`, `database_bulk.json`)
- **Deploy**: Docker / Railway

## Project Structure

```
server.ts          — Single Bun.serve() server, all endpoints
public/
  index.html       — Two-tab UI (Single + Bulk Upload)
  script.js        — Client logic, SSE handling, file validation
  style.css        — All styles
input/             — Uploaded originals (single mode)
output/            — Processed images (single mode)
bulk/              — Bulk task dirs + zip files
database.json      — Single-image history
database_bulk.json — Bulk task records
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/optimise` | Single image optimise (rate-limited, 5/IP) |
| `GET` | `/history` | User's single-image history (filtered by IP) |
| `GET` | `/output/:filename` | Download processed single image |
| `POST` | `/bulk-optimise` | Upload up to 100 images (≤10MB each). Returns `{ taskId }` |
| `GET` | `/bulk-events/:taskId` | SSE stream: `status`, `progress`, `completed`, `error` events |
| `GET` | `/bulk-status/:taskId` | Polling fallback for task status |
| `GET` | `/bulk-download/:taskId` | Download completed zip |
| `GET` | `/bulk-history` | User's bulk task history (filtered by IP) |

## Bulk Upload Flow

1. Client sends files + `scale` (10-90) + `quality` (50-100) to `POST /bulk-optimise`
2. Server validates limits, creates task in DB, returns `taskId` immediately
3. Async: each image is resized → converted to WebP → written to `bulk/<taskId>/`
4. After all processed, Archiver creates a zip in `bulk/`
5. DB updated with `zipSize`, status set to `completed`
6. Client receives real-time updates via SSE (`/bulk-events/:taskId`)

## Cleanup

Hourly cron deletes files + DB entries older than 24h from `input/`, `output/`, `bulk/`, and both JSON databases. Rate limits are also reset hourly.

## Limits

- **Single mode**: 5 requests per IP (reset hourly)
- **Bulk mode**: Max 100 files, max 10MB per file
- **Data retention**: 24 hours
