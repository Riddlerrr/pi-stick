FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/*
ARG NPM_VERSION=12.2.3
RUN npm install --global npm@${NPM_VERSION} --ignore-scripts --no-audit --no-fund
WORKDIR /app
COPY --chmod=0644 package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chmod=0644 agent-runtime.ts runtime-auth.ts ./
USER node
CMD ["node", "/app/agent-runtime.ts"]
