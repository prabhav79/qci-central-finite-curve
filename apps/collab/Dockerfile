FROM node:22-alpine

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/doc-worker/package.json apps/doc-worker/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/qci-seed/package.json packages/qci-seed/
COPY packages/doc-fixtures/package.json packages/doc-fixtures/

RUN npm install --workspace @cfc/collab --include-workspace-root --ignore-scripts

COPY apps/collab apps/collab

ENV COLLAB_PORT=8200
EXPOSE 8200
CMD ["sh", "-c", "cd apps/collab && npx tsx src/index.ts"]
