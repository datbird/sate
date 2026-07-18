# Sate self-hosted edition — @sate/core on Node/Hono over local SQLite. Replaces the PocketBase image.
# Build from the REPO ROOT so the shared core/ is in context:  docker build -f server/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci
COPY server ./server
COPY core ./core
RUN cd server && npm run build

FROM node:20-slim
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package*.json ./
# better-sqlite3 is a native dependency; npm fetches a prebuilt binary for node20-slim.
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/web ./web
# SATE_DATA (default ./pb_data) holds the SQLite db + files; mount it as a volume.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
