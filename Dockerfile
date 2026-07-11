# Sate — PocketBase + JS hooks, single self-contained image.
FROM alpine:3.20

ARG PB_VERSION=0.39.5
# TARGETARCH is set automatically by BuildKit (amd64 / arm64) and matches PocketBase's asset names.
ARG TARGETARCH=amd64
# Pin the release artifact by SHA-256 so a swapped, corrupted, or MITM'd upstream asset fails the
# build instead of silently shipping an arbitrary binary. Update these when bumping PB_VERSION:
#   curl -fsSL <release-zip-url> | sha256sum
ARG PB_SHA256_AMD64=be407d824bcc41468b99051f356fbba9af7f0efd9b46c168482ae25296e799c7
ARG PB_SHA256_ARM64=83b79cae15452673c83269d1676eb41f90cf42854c00b0ea53d33c5e3290d10d

# su-exec lets the entrypoint drop from root to the unprivileged `pb` user after fixing up perms on
# the (possibly root-owned) mounted data dir.
RUN apk add --no-cache ca-certificates unzip wget su-exec \
 && addgroup -S pb && adduser -S -G pb pb

ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip /tmp/pb.zip
RUN case "$TARGETARCH" in \
      amd64) EXPECT="$PB_SHA256_AMD64" ;; \
      arm64) EXPECT="$PB_SHA256_ARM64" ;; \
      *) echo "no PocketBase checksum pinned for arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && echo "${EXPECT}  /tmp/pb.zip" | sha256sum -c - \
 && unzip /tmp/pb.zip -d /pb && rm /tmp/pb.zip

COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
COPY pb_public /pb/pb_public
COPY docker-entrypoint.sh /pb/entrypoint.sh
RUN chmod +x /pb/entrypoint.sh

EXPOSE 8080
VOLUME ["/pb/pb_data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1

# The entrypoint starts as root only long enough to chown the data dir, then execs PocketBase as `pb`.
ENTRYPOINT ["/pb/entrypoint.sh"]
