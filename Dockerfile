FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install sharp's native dependencies
RUN apk add --no-cache vips-dev build-base

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy application
COPY server.ts ./
COPY public ./public/

# Create storage directories
RUN mkdir -p input output bulk

CMD ["bun", "server.ts"]
