ARG BASE_IMAGE=nousresearch/hermes-agent@sha256:8aab4fb9665995cafc118546d071caf7b12fc36ef038dbb81bd4ca1cdb2a1ccc
ARG STEEL_COMMIT=5880b48c1af107219ff3d904edbb8f6b76bea9b6
ARG STEEL_ARCHIVE_SHA256=4248ee256c94a5c371806b7c51f00e3639d84992fcf16a60187d69b5f02d14ed

FROM node:22.13.0-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff AS steel-build
ARG STEEL_COMMIT
ARG STEEL_ARCHIVE_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config python-is-python3 patch && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL --retry 3 "https://github.com/steel-dev/steel-browser/archive/${STEEL_COMMIT}.tar.gz" -o steel.tar.gz \
    && echo "${STEEL_ARCHIVE_SHA256}  steel.tar.gz" | sha256sum -c - \
    && mkdir steel \
    && tar -xzf steel.tar.gz -C steel --strip-components=1 \
    && rm steel.tar.gz
WORKDIR /src/steel
COPY docker/steel-browser-egress.patch /tmp/steel-browser-egress.patch
RUN patch -p1 < /tmp/steel-browser-egress.patch \
    && npm pkg set scripts.prepare="echo skip husky" \
    && npm ci --include=dev --workspace=api \
    && cd api/extensions/recorder && npm ci --include=dev && npm run build \
    && cd /src/steel \
    && npm run build -w api

FROM node:22.13.0-slim@sha256:f5a0871ab03b035c58bdb3007c3d177b001c2145c18e81817b71624dcf7d8bff AS steel-runtime
WORKDIR /opt/steel
COPY docker/steel-runtime-package.json ./package.json
COPY docker/steel-runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund \
    && npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=low

FROM ${BASE_IMAGE}
ARG NODE_VERSION=24.15.0
ARG NODE_X64_SHA256=44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89
ARG NODE_ARM64_SHA256=73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg make g++ chromium chromium-driver \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-freefont-ttf \
    libxss1 xvfb dbus dbus-x11 procps x11-xserver-utils \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then NODE_ARCH="x64"; NODE_SHA256="$NODE_X64_SHA256"; \
       elif [ "$ARCH" = "arm64" ]; then NODE_ARCH="arm64"; NODE_SHA256="$NODE_ARM64_SHA256"; \
       else echo "Unsupported Node architecture: $ARCH" >&2; exit 1; fi \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.gz \
    && node --version && npm --version
WORKDIR /app
COPY package*.json ./
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm ci --ignore-scripts && npm rebuild node-pty
COPY . .
RUN npm run build && npm prune --omit=dev
COPY --from=steel-runtime /opt/steel/package.json /opt/steel/package.json
COPY --from=steel-runtime /opt/steel/package-lock.json /opt/steel/package-lock.json
COPY --from=steel-runtime /opt/steel/node_modules /opt/steel/node_modules
COPY --from=steel-build /src/steel/api/build /opt/steel/api/build
COPY --from=steel-build /src/steel/api/extensions/recorder/manifest.json /opt/steel/api/extensions/recorder/manifest.json
COPY --from=steel-build /src/steel/api/extensions/recorder/icon.png /opt/steel/api/extensions/recorder/icon.png
COPY --from=steel-build /src/steel/api/extensions/recorder/dist /opt/steel/api/extensions/recorder/dist
COPY --from=steel-build /usr/local/bin/node /opt/steel-node/node
COPY docker/entrypoint.sh /usr/local/bin/hermes-studio-entrypoint
RUN chmod 0755 /usr/local/bin/hermes-studio-entrypoint /opt/steel-node/node && mkdir -p /files /opt/steel/.cache
ENV NODE_ENV=production
ENV HOME=/home/agent
ENV HERMES_HOME=/home/agent/.hermes
ENV HERMES_WEB_UI_MANAGED_GATEWAY=1
ENV HERMES_STEEL_BROWSER_URL=http://127.0.0.1:3000
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV DISPLAY=:10
ENV PATH=/opt/hermes/.venv/bin:$PATH
EXPOSE 6060
ENTRYPOINT ["/usr/local/bin/hermes-studio-entrypoint"]
CMD []
