# Node 20 reached end-of-life in April 2026
FROM node:22-alpine

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install production dependencies exactly as locked
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source code (see .dockerignore)
COPY --chown=node:node . .

# Run as the unprivileged user shipped with the node image
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# node directly (not npm) so SIGTERM reaches the app and triggers the graceful shutdown
CMD ["node", "src/index.js"]
