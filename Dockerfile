# syntax=docker/dockerfile:1.7
#
# Ленканбан — production-образ (issue #73).
#
# ПРЕДУСЛОВИЕ: в `next.config.mjs` включён `output: 'standalone'` (снято 21.10.2026).
# Без этой строки стадия `runner` не сможет скопировать `.next/standalone`.
#
# Дополнительно: `server.js` в корне — кастомный сервер (`next({ dev, hostname, port })`).
# Standalone-режим его НЕ использует: Next генерирует собственный `.next/standalone/server.js`,
# который и запускается в `runner`. Корневой `server.js` в образ не копируется.
#
# Два целевых образа из одного Dockerfile:
#   --target runner  → Next.js (standalone), публикуется через nginx на 127.0.0.1:18766
#   --target socket  → отдельный процесс Socket.IO (src/socket/server.ts), только loopback 127.0.0.1:18767
# Разделение обязательно: Socket.IO запускается отдельным процессом (см. server.js, ecosystem.config.js)
# и собирается отдельно в CommonJS без tsx и исходников в runtime.

ARG NODE_IMAGE=node:22.22.2-bookworm-slim

# OpenSSL должен присутствовать и при prisma generate: иначе auto-detection
# может выбрать несовместимый движок. Этот слой общий для обоих runtime-образов.
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# deps — полный набор зависимостей (включая dev: нужны prisma CLI, tsx, sharp)
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
COPY scripts/patch-react-big-calendar.mjs ./scripts/
COPY scripts/patches/react-big-calendar-1.19.4-a11y.json ./scripts/patches/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# builder — prisma generate + next build
# NEXT_PUBLIC_* инлайнятся на этапе сборки, поэтому передаются как build args.
# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

ARG NEXT_PUBLIC_APP_URL=https://taskboard.lenremontn8n.ru
ARG NEXT_PUBLIC_SOCKET_URL=
ARG GIT_COMMIT=unknown
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL} \
    GIT_COMMIT=${GIT_COMMIT}

COPY --from=deps /app/node_modules ./node_modules
# Reuse the pinned engines fetched by npm ci; this cache stays in the builder.
# A fresh engine fetch inside BuildKit can stall before client generation.
COPY --from=deps /root/.cache/prisma /root/.cache/prisma
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY . .

# Сборка без доступа к рабочей БД: DATABASE_URL нужен только для runtime,
# но prisma generate его не читает. Пустое значение не подставляется намеренно.
# The generated Prisma types exceed Node 22's default 2 GiB heap during the
# build type check. This bound applies only to compilation, never runtime.
RUN NODE_OPTIONS=--max-old-space-size=3072 npm run build \
 && node scripts/runtime-image.mjs .next/standalone \
 && node scripts/build-request-provision.mjs \
 && node scripts/build-beznal-provision.mjs

# ---------------------------------------------------------------------------
# socket-builder — JS bundle + traced production dependencies, без next build.
# esbuild разрешает @/* по tsconfig; пакеты остаются external для Prisma/Pino.
# ---------------------------------------------------------------------------
FROM deps AS socket-builder
ENV NODE_ENV=production
COPY prisma ./prisma
RUN ./node_modules/.bin/prisma generate
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-socket.mjs scripts/runtime-image.mjs ./scripts/
RUN node scripts/build-socket.mjs \
 && node --check socket-runtime/dist/socket/server.js

# ---------------------------------------------------------------------------
# runner — минимальный production-образ Next.js (standalone)
# ---------------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ATTACHMENT_STORAGE=local \
    ATTACHMENT_LOCAL_DIR=/data/attachments

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin nextjs

# Standalone-бандл: server.js + минимальный node_modules + трассированные файлы.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/request-board-provision.cjs ./request-board-provision.cjs
COPY --from=builder --chown=nextjs:nodejs /app/beznal-op-provision.cjs ./beznal-op-provision.cjs

# prisma/ и prisma CLI в runtime-образ НЕ копируются: миграции выполняет
# отдельный сервис `migrate` (стадия builder) по RUNBOOK. Клиент Prisma уже
# входит в standalone-бандл, т.к. трассируется из импортов.

RUN mkdir -p /data/attachments \
 && chown nextjs:nodejs /data/attachments \
 && chmod 700 /data/attachments
VOLUME ["/data/attachments"]

USER nextjs
EXPOSE 3000

# Healthcheck без curl/wget: slim-образ содержит только node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/auth/session',timeout:4000},r=>process.exit(r.statusCode&&r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# Это НЕ корневой server.js из репозитория, а сгенерированный standalone-сервер.
CMD ["node", "--require", "./api-observation-preload.cjs", "server.js"]

# ---------------------------------------------------------------------------
# socket — отдельный процесс Socket.IO (тот же код, тот же образ-базис)
# Работает от непривилегированного пользователя, порт только внутренний.
# ---------------------------------------------------------------------------
FROM base AS socket
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SOCKET_PORT=3556

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home --shell /usr/sbin/nologin nextjs

COPY --from=socket-builder --chown=nextjs:nodejs /app/socket-runtime/ ./

USER nextjs

# Сгенерированный клиент и один движок уже подготовлены в socket-builder.
# CLI, tsx, исходники и полный node_modules стадии deps здесь отсутствуют.
EXPOSE 3556

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.SOCKET_PORT||3556,path:'/socket.io/?EIO=4&transport=polling',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/socket/server.js"]
