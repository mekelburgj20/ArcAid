# Stage 1: Build React Admin UI
FROM node:20-alpine AS frontend-build
WORKDIR /app/admin-ui
COPY admin-ui/package*.json ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build

# Stage 2: Build Node Backend
FROM node:20-alpine AS backend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 3: Production Image
FROM mcr.microsoft.com/playwright:v1.62.0-noble AS production

# The Playwright noble base ships Node 24; pin it explicitly via NodeSource so the
# app's runtime Node version is independent of the base image's bundled Node.
# curl is also required by the HEALTHCHECK below.
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy backend dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built backend
COPY --from=backend-build /app/dist ./dist

# Copy built frontend
COPY --from=frontend-build /app/admin-ui/dist ./admin-ui/dist

# Ensure data and backups directories exist
RUN mkdir -p data backups

# Add non-root user for security. Pin arcaid to uid 999 to MATCH the jammy image's
# arcaid UID (999): the bind-mounted /app/data and the existing arcaid.db carry that
# ownership from prod's jammy history, and the CMD's chown of /app/data is
# non-recursive (deliberately, to avoid walking catalogue-images). Without this pin,
# noble's default arcaid (997) can't write the 999-owned DB -> SQLITE_READONLY crash
# on boot. (gid is left auto: 999 is taken by systemd-journal on noble, but owner-UID
# governs file writes regardless of gid.)
RUN groupadd -r arcaid && useradd -r -u 999 -g arcaid -d /app arcaid \
    && chown -R arcaid:arcaid /app

# Build metadata (S10 in-app version display). Passed as build-args by
# deploy.yml; surfaced at runtime via getVersionInfo() -> GET /api/version and
# the admin health card. NOT the SW CACHE_NAME.
ARG GIT_SHA=""
ARG BUILT_AT=""
ENV APP_GIT_SHA=$GIT_SHA
ENV APP_BUILT_AT=$BUILT_AT

# Expose the API/Frontend port
EXPOSE 3001

# Health check — verify API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3001/api/status || exit 1

# Fix ownership of mounted volumes at startup, then drop to non-root user.
# Only chowns the top-level data/backups dirs (not recursively) to avoid slow
# walks over large directories like catalogue-images on bind-mounted volumes.
# Writable subdirs are created by the app on demand.
CMD ["/bin/bash", "-c", "chown arcaid:arcaid /app/data /app/backups 2>/dev/null; exec su -s /bin/bash arcaid -c 'npm start'"]
