# Build stage
FROM node:22-alpine AS builder

WORKDIR /build

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy all packages and apps
COPY apps ./apps
COPY packages ./packages

# Install dependencies (remove lockfile to bypass platform mismatch)
RUN npm install -g pnpm && rm pnpm-lock.yaml && pnpm install

# Build food-bot and its dependencies
RUN pnpm build --filter @bisya/food-bot


# Runtime stage
FROM node:22-alpine

WORKDIR /app/apps/food-bot

# Copy built files from builder
COPY --from=builder /build/apps/food-bot/dist ./dist
COPY --from=builder /build/apps/food-bot/package.json ./

# Copy seed data
COPY apps/food-bot/seed/food-triggers.csv ./seed/food-triggers.csv

# Install runtime dependencies only (no devDependencies)
RUN npm install -g pnpm && \
    rm pnpm-lock.yaml && pnpm install --prod

# Health check (optional - bot doesn't expose HTTP, but we can check if process is running)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -f "node dist/src/bot.js" > /dev/null || exit 1

# Run the bot
ENTRYPOINT ["node", "dist/src/bot.js"]
