# Build stage
FROM node:22-alpine AS builder

WORKDIR /build

# Copy workspace configuration files
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./

# Copy all packages and apps
COPY apps ./apps
COPY packages ./packages

# Install dependencies with the pnpm version pinned in package.json
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN pnpm install --frozen-lockfile

# Build food-bot and its workspace dependencies
RUN pnpm --filter @bisya/food-bot... build


# Runtime stage
FROM node:22-alpine

# Carry over the already-resolved workspace (node_modules, dist, seed data)
# from the builder stage rather than re-running pnpm install in isolation,
# since the app package.json alone lacks the workspace/lockfile context
# pnpm needs to resolve its workspace:* dependencies.
COPY --from=builder /build /app

WORKDIR /app/apps/food-bot

# Health check (optional - bot doesn't expose HTTP, but we can check if process is running)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -f "node dist/src/bot.js" > /dev/null || exit 1

# Run the bot
ENTRYPOINT ["node", "dist/src/bot.js"]
