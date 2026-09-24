FROM node:22-alpine AS builder

WORKDIR /repo

# Install dependencies at the monorepo root so npm workspaces resolve.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/doc-worker/package.json apps/doc-worker/
COPY apps/collab/package.json apps/collab/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/qci-seed/package.json packages/qci-seed/
COPY packages/doc-fixtures/package.json packages/doc-fixtures/

RUN npm install --workspaces --include-workspace-root --ignore-scripts

COPY apps/web apps/web
COPY packages packages

# Next.js bakes NEXT_PUBLIC_* vars into the client bundle at BUILD time, not
# runtime — they must arrive as Docker build ARGs (Railway passes matching
# service variables as --build-arg automatically, but only for ARGs declared
# here) and then be exported as ENV so `next build` picks them up.
ARG NEXT_PUBLIC_CFC_API_BASE
ARG NEXT_PUBLIC_CFC_DOC_WORKER_BASE
ENV NEXT_PUBLIC_CFC_API_BASE=$NEXT_PUBLIC_CFC_API_BASE
ENV NEXT_PUBLIC_CFC_DOC_WORKER_BASE=$NEXT_PUBLIC_CFC_DOC_WORKER_BASE

# Sync SuperDoc workers into public/ before build (predev/prebuild does this locally).
RUN cd apps/web && node ./scripts/sync-superdoc-workers.mjs && npm run build

FROM node:22-alpine AS runner
WORKDIR /repo

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/web ./apps/web
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/package.json ./

EXPOSE 3000
CMD ["sh", "-c", "cd apps/web && npx next start --port ${PORT:-3000}"]
