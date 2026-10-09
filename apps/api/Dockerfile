# The API's production image: the self-contained tsdown bundle on Node, nothing else.
# Build it from the repository root (the build context): `pnpm nx run api:docker-build`, or
#   docker build -f apps/api/Dockerfile .
# It runs `node dist/main.mjs`. The same image applies the migrations before a deploy (Railway's
# pre-deploy command): `node dist/migrate.mjs`. docs/deployment.md has the details.

# Node and pnpm: the versions of .node-version, .prototools and package.json#packageManager
# (tools/check-versions.mjs fails when they disagree).
FROM node:24.21.0-trixie-slim AS build
# CI: pnpm and Nx without a terminal (no prompts, no Nx daemon). NX_USE_LOCAL: Nx never downloads
# nx@latest for its own checks.
ENV CI=true NX_DAEMON=false NX_NO_CLOUD=true NX_USE_LOCAL=true NX_TUI=false
# npm, not corepack: Node 25+ images no longer ship corepack.
RUN npm install --global --no-audit --no-fund pnpm@11.27.1
WORKDIR /repo
# Dependencies: this layer is rebuilt only when the lockfile or the workspace settings change. No
# BuildKit cache mount: Railway rejects one without its service id in the mount's id.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# The same stage as `pnpm fetch`: the offline install reuses its lockfile verification.
RUN pnpm install --offline --frozen-lockfile
# Generated files are committed: build the app alone, without its generators.
RUN pnpm nx run api:build --excludeTaskDependencies --outputStyle=static

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production PORT=4000
WORKDIR /app
# The whole dist/ (main.mjs and migrate.mjs share chunks) and the migrations, owned by root:
# the app cannot change its own code.
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
USER node
EXPOSE 4000
# Slim images have no curl. Railway ignores this (it checks /health itself); Docker and compose
# use it.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form: Node is PID 1 and gets SIGTERM itself (src/main.ts closes the server, then the pool).
CMD ["node", "dist/main.mjs"]
