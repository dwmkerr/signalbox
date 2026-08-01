# The repository root must be the build context because the CLI sources live outside this directory.

FROM oven/bun:1.3.14 AS build
WORKDIR /src
COPY components/cli/package.json components/cli/bun.lock components/cli/tsconfig.json ./
RUN bun install --frozen-lockfile
COPY components/cli/src/ ./src/
RUN bun build --compile --minify src/main.ts --outfile /out/signalbox

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/signalbox /usr/local/bin/signalbox

# events.jsonl lives here - mount a volume so the board survives restarts.
ENV SIGNALBOX_STATE_DIR=/data
ENV SIGNALBOX_REMOTE=1
VOLUME /data

EXPOSE 8377
# /healthz is unauthenticated by design (specs/events.md), so no token here.
HEALTHCHECK --interval=30s --timeout=3s \
    CMD curl -fsS http://127.0.0.1:8377/healthz || exit 1

ENTRYPOINT ["signalbox", "hub"]
