# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL, which the alpine image does not ship.
RUN apk add --no-cache openssl

FROM base AS deps
# Manifests first so a source change does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY prisma ./prisma
# Dev dependencies are installed and kept: `prisma generate` needs the Prisma CLI,
# which is a devDependency, and pruning afterwards risks removing the generated client
# in node_modules/.prisma along with it. A larger image is the honest trade here.
RUN npm ci --ignore-scripts && npx prisma generate

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY apps/api ./apps/api

# Run unprivileged; node:alpine ships a `node` user for exactly this.
USER node
EXPOSE 4000

# Makes the container self-reporting even when run outside compose.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/server.js"]
