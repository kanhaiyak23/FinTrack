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
COPY apps/worker ./apps/worker

# Run unprivileged; node:alpine ships a `node` user for exactly this.
USER node
# No port and no HTTP healthcheck: the worker serves nothing. Its liveness shows up as
# queue depth and outbox backlog, which is where it would actually be diagnosed.
CMD ["node", "apps/worker/src/worker.js"]
