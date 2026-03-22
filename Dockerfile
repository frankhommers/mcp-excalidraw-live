# Dockerfile for MCP Excalidraw Server
# Builds and runs the combined canvas + MCP server using Bun

# Stage 1: Build
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install all dependencies
RUN bun install --frozen-lockfile

# Copy source
COPY src ./src
COPY frontend ./frontend
COPY tsconfig.json vite.config.js ./

# Build everything
RUN bun run build

# Stage 2: Production
FROM oven/bun:1-slim AS production

# Create non-root user
RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid 1001 --no-create-home appuser

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy built files
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R appuser:appuser /app

USER appuser

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Expose port
EXPOSE 3000

# Run server
CMD ["bun", "dist/server.js"]

# Labels
LABEL org.opencontainers.image.source="https://github.com/frankhommers/mcp-excalidraw-live"
LABEL org.opencontainers.image.description="mcp-excalidraw-live — Live Excalidraw canvas with MCP Streamable HTTP"
LABEL org.opencontainers.image.licenses="MIT"
