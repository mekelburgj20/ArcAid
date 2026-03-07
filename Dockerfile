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

# Ensure data directory exists
RUN mkdir -p data

# Expose the API/Frontend port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
