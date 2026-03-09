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
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS production

# Install Node.js on the Playwright Ubuntu image
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
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

# Add non-root user for security
RUN groupadd -r arcaid && useradd -r -g arcaid -d /app arcaid \
    && chown -R arcaid:arcaid /app

# Expose the API/Frontend port
EXPOSE 3001

# Health check — verify API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3001/api/status || exit 1

# Fix ownership of mounted volumes at startup, then drop to non-root user
CMD chown -R arcaid:arcaid /app/data /app/backups 2>/dev/null; exec su -s /bin/bash arcaid -c "npm start"
