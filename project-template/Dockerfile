FROM debian:bookworm-slim
ARG UID=1000
ARG GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && (getent group "$GID" >/dev/null || groupadd --gid "$GID" agent) \
    && useradd --create-home --uid "$UID" --gid "$GID" agent \
    && install -d -o agent -g "$GID" /workspace /scratch
COPY --chmod=755 setup-project /usr/local/bin/
USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
