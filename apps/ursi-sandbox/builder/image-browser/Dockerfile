# Browser-capable Ubuntu runtime. Build the base execution image first:
#   builder/build-image.sh pi
#   builder/build-image.sh browser
FROM ursi-runtime-pi:local
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG UBUNTU_APT_MIRROR=http://mirrors.aliyun.com/ubuntu
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG NODE20_VERSION=20.20.2
ARG NODE_MIRROR=https://npmmirror.com/mirrors/node
ARG CHROME_FOR_TESTING_VERSION=149.0.7827.55
ARG CHROME_FOR_TESTING_MIRROR=https://npmmirror.com/mirrors/chrome-for-testing
ENV DEBIAN_FRONTEND=noninteractive
ENV http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= all_proxy=
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CODE_SERVER_VERSION=4.96.4
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY \
    && sed -i -E "s#https?://(archive|security).ubuntu.com/ubuntu#${UBUNTU_APT_MIRROR}#g" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
      x11vnc xvfb socat python3-websockify curl unzip \
      build-essential libkrb5-dev libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 \
      libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libasound2t64 libcairo2 \
      libpango-1.0-0 libxcomposite1 libatspi2.0-0t64 \
    && rm -rf /var/lib/apt/lists/*
RUN unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY \
    && arch="$(dpkg --print-architecture)" \
    && case "${arch}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; esac \
    && node_archive="node-v${NODE20_VERSION}-linux-${node_arch}.tar.xz" \
    && curl --fail --location --retry 5 --retry-delay 2 \
      "${NODE_MIRROR}/v${NODE20_VERSION}/${node_archive}" \
      --output "/tmp/${node_archive}" \
    && curl --fail --location --retry 5 --retry-delay 2 \
      "${NODE_MIRROR}/v${NODE20_VERSION}/SHASUMS256.txt" \
      --output /tmp/SHASUMS256.txt \
    && cd /tmp \
    && grep "  ${node_archive}$" SHASUMS256.txt | sha256sum -c - \
    && cd / \
    && mkdir -p /opt/node20 \
    && tar -xJf "/tmp/${node_archive}" --strip-components=1 -C /opt/node20 \
    && rm -f "/tmp/${node_archive}" /tmp/SHASUMS256.txt \
    && export PATH=/opt/node20/bin:${PATH} \
    && npm_config_unsafe_perm=true npm_config_maxsockets=1 npm_config_fetch_retries=5 npm --prefix /usr/local install --global --ignore-scripts --registry="${NPM_REGISTRY}" \
      "code-server@${CODE_SERVER_VERSION}" "playwright@1.61.1" \
    && cd /usr/local/lib/node_modules/code-server \
    && npm_config_registry="${NPM_REGISTRY}" npm_config_user_agent="npm/10.9.2 node/v${NODE20_VERSION} linux x64" npm_config_unsafe_perm=true npm_config_maxsockets=1 npm_config_fetch_retries=5 ./postinstall.sh \
    && cd / \
    && mkdir -p /ms-playwright/chromium-1228 \
    && curl --fail --location --retry 5 --retry-delay 2 \
      "${CHROME_FOR_TESTING_MIRROR}/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip" \
      --output /tmp/chrome-linux64.zip \
    && unzip -q /tmp/chrome-linux64.zip -d /tmp \
    && mv /tmp/chrome-linux64 /ms-playwright/chromium-1228/chrome-linux64 \
    && touch /ms-playwright/chromium-1228/INSTALLATION_COMPLETE \
    && rm -f /tmp/chrome-linux64.zip \
    && chmod 0755 /ms-playwright/chromium-1228/chrome-linux64/chrome \
    && cd /usr/local/lib/node_modules/code-server \
    && npm_config_registry="${NPM_REGISTRY}" npm_config_unsafe_perm=true npm_config_maxsockets=1 npm_config_fetch_retries=5 npm rebuild argon2 --build-from-source \
    && rm /usr/local/bin/code-server \
    && printf '%s\n' '#!/bin/sh' 'exec /opt/node20/bin/node /usr/local/lib/node_modules/code-server/out/node/entry.js "$@"' > /usr/local/bin/code-server \
    && chmod 0755 /usr/local/bin/code-server
RUN code-server --version --config /tmp/code-server-check.yaml \
    && rm -f /tmp/code-server-check.yaml \
    && /ms-playwright/chromium-1228/chrome-linux64/chrome --version
RUN printf '2\n' >/etc/ursi-image-level
LABEL io.ursi.image-level="2" io.ursi.environment-profile="browser"
ENV URSI_BROWSER_RUN_DIR=/run/ursi/browser \
    URSI_BROWSER_PROFILE_DIR=/ursi/workspace/.browser-profile
RUN mv /ursi/healthcheck /ursi/healthcheck-pi
COPY bundles/browser/healthcheck.py /ursi/healthcheck
RUN chmod 0755 /ursi/healthcheck
HEALTHCHECK --interval=10s --timeout=16s --start-period=30s --retries=3 CMD ["/ursi/healthcheck"]
EXPOSE 8744 9222 6080
