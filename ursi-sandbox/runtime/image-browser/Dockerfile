# Browser-capable Ubuntu runtime. Build the base execution image first:
#   docker build -t ursi-runtime-pi:local runtime/image
#   docker build -t ursi-runtime-browser:local runtime/image-browser
FROM ursi-runtime-pi:local
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV CODE_SERVER_VERSION=4.96.4
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
      x11vnc xvfb socat python3-websockify curl \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --registry="${NPM_REGISTRY:-https://registry.npmjs.org}" \
      "code-server@${CODE_SERVER_VERSION}" "playwright@1.61.1" \
    && npx playwright install chromium \
    && code-server --version
RUN printf '2\n' >/etc/ursi-image-level
LABEL io.ursi.image-level="2" io.ursi.environment-profile="browser"
ENV URSI_BROWSER_RUN_DIR=/run/ursi/browser \
    URSI_BROWSER_PROFILE_DIR=/ursi/workspace/.browser-profile
EXPOSE 8744 9222 6080
