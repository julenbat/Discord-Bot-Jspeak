# Multi-stage: deps de producción / puerta de tipos / runtime mínimo.
# Debian slim y no Alpine: tzdata presente (TZ funciona) y glibc para
# cualquier prebuild futuro. CMD en forma exec: npm como PID 1 no propaga
# SIGTERM y el apagado ordenado no llegaría a ejecutarse jamás.
FROM node:24.21.0-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.21.0-trixie-slim AS check
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npx tsc --noEmit

FROM node:24.21.0-trixie-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
USER node
CMD ["node", "src/main.ts"]
