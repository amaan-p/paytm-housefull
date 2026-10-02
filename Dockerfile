# ---- deps: install production dependencies only ----
FROM node:24-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@11.28.3
COPY package.json pnpm-lock.yaml ./
# better-sqlite3 ships prebuilt linux binaries, so no compiler is needed
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/app.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# the SQLite file lives here; mount a volume on /data so it survives restarts
# (docker run -v ..., or a Railway volume). No VOLUME instruction: Railway rejects it.
# runs as root because platform volumes (Railway) are mounted root-owned.
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form: node is PID 1 and receives SIGTERM directly → graceful shutdown runs
CMD ["node", "src/server.js"]
