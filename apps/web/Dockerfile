# The web server's production image: Nitro's self-contained .output on Node, nothing else.
# Build it from the repository root (the build context): `pnpm nx run web:docker-build`, or
#   docker build -f apps/web/Dockerfile .
# It needs INTERNAL_API_SECRET, API_HOST and API_PORT at runtime (/api/health answers 503 without
# them). docs/deployment.md has the details.

# Node and pnpm: the versions of .node-version, .prototools and package.json#packageManager
# (tools/check-versions.mjs fails when they disagree). The stage up to `pnpm install` is the
# API's, line for line, so the two builds share its cached layers.
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
# Generated files (routes, GraphQL types) are committed: build the app alone, without its
# generators.
RUN pnpm nx run web:build --excludeTaskDependencies --outputStyle=static

FROM node:24.21.0-trixie-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# Self-contained (dependencies bundled), owned by root: the app cannot change its own code.
COPY --from=build /repo/apps/web/.output ./.output
USER node
EXPOSE 3000
# Slim images have no curl. Railway ignores this (it checks /api/health itself); Docker and compose
# use it. /api/health checks this server's configuration, never the API.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form: Node is PID 1 and gets SIGTERM itself (Nitro closes its server).
CMD ["node", ".output/server/index.mjs"]
