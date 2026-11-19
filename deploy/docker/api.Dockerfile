# Build from the repository root:  docker build -f deploy/docker/api.Dockerfile -t kube-triage-api .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 # A self-contained copy of the API and its production dependencies only.
 && pnpm --filter @kube-triage/api deploy --legacy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
# The unprivileged "node" user that ships with the image.
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
