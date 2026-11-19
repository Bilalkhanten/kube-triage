# Build from the repository root:  docker build -f deploy/docker/web.Dockerfile -t kube-triage-web .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm build:web

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# Next.js standalone output: a minimal server plus only the files it needs.
COPY --from=build /repo/packages/web/.next/standalone/ ./
COPY --from=build /repo/packages/web/.next/static ./packages/web/.next/static
USER node
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "packages/web/server.js"]
