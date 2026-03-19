# Image Optimizer

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/image-optimiser-and-resizer?referralCode=hUuv5P&utm_medium=integration&utm_source=template&utm_campaign=generic)

A lightweight image optimization tool built with **Bun** and **Sharp.js**. Upload images and convert to WebP, resize, or do both — all through a clean, mobile-responsive web UI.

## Features

- **WebP Conversion** — Convert any image to 70% quality WebP
- **Resize** — Scale image dimensions from 10% to 90%
- **Resize & Optimise** — Resize and convert to WebP in one step
- **History** — Track all past optimizations with file size comparisons
- **Download** — Download optimized images directly from the browser
- **Forgetful** — Forget all past optimizations within 24 hours

## Setup

### Prerequisites

- [Bun](https://bun.sh/) (v1.0+)

### Install

```bash
bun install
```

### Run (dev)

```bash
bun run dev
```

### Run (production)

```bash
bun run start
```

The server starts at **http://localhost:3000**.

## API

### `POST /optimise`

Accepts `multipart/form-data`:

| Field   | Type   | Description                                        |
| ------- | ------ | -------------------------------------------------- |
| `image` | File   | The image file to optimize                         |
| `mode`  | String | `webp`, `resize`, or `resize-and-optimise`         |
| `scale` | String | Scale percentage (10–90). Ignored for `webp` mode. |

**Response:** The optimized image as a binary download.

### `GET /history`

Returns `database.json` contents (array of optimization records).

### `GET /output/:filename`

Serves an optimized file from the `output/` directory.

## Folder Structure

```
image-conversion/
├── server.ts          # Bun API server
├── package.json
├── database.json      # History store
├── README.md
├── input/             # Uploaded originals
├── output/            # Optimized results
└── public/            # Static frontend
    ├── index.html
    ├── style.css
    └── script.js
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Image Processing:** [Sharp](https://sharp.pixelplumbing.com/)
- **Frontend:** Vanilla HTML / CSS / JS




