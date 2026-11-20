FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 agent && install -d -o agent -g agent /workspace /scratch
COPY --chmod=755 setup-project /usr/local/bin/
USER agent
WORKDIR /workspace
CMD ["sleep", "infinity"]
