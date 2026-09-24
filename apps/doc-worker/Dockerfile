# NOT node:22-alpine: @superdoc-dev/sdk ships a native "host process" binary
# per-platform (@superdoc-dev/sdk-linux-x64, etc.) with only one generic
# linux-x64 variant published — built against glibc, not Alpine's musl libc.
# On Alpine this fails at runtime with a generic "Host process failed."
# error (SuperDoc's own SDK error, not ours) rather than a missing-binary
# error, which is what actually surfaced this on Railway.
FROM node:22-slim

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/doc-worker/package.json apps/doc-worker/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/collab/package.json apps/collab/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/qci-seed/package.json packages/qci-seed/
COPY packages/doc-fixtures/package.json packages/doc-fixtures/

RUN npm install --workspace @cfc/doc-worker --include-workspace-root --ignore-scripts

COPY apps/doc-worker apps/doc-worker
COPY packages/doc-fixtures packages/doc-fixtures

ENV DOC_WORKER_PORT=8100
EXPOSE 8100
CMD ["sh", "-c", "cd apps/doc-worker && npx tsx src/index.ts"]
