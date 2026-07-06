# Sate — PocketBase + JS hooks, single self-contained image.
FROM alpine:3.20

ARG PB_VERSION=0.39.5
# TARGETARCH is set automatically by BuildKit (amd64 / arm64) and matches PocketBase's asset names.
ARG TARGETARCH=amd64

RUN apk add --no-cache ca-certificates unzip wget

ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb && rm /tmp/pb.zip

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY pb_public /pb/pb_public
COPY docker-entrypoint.sh /pb/entrypoint.sh
RUN chmod +x /pb/entrypoint.sh

EXPOSE 8080
VOLUME ["/pb/pb_data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/pb/entrypoint.sh"]
