ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE} AS sshd-build
ENV DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_SOURCE_MIRROR=http://archive.ubuntu.com/ubuntu/
# Ubuntu's audit-enabled sshd aborts PTY login without AUDIT_WRITE. Build the
# distro-patched source without audit, preserving the fixed runtime capability set.
RUN sed -i -e 's/^Types: deb$/Types: deb deb-src/' -e 's/^Components:.*/Components: main/' \
       -e "s|^URIs:.*|URIs: ${UBUNTU_SOURCE_MIRROR}|" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
       build-essential dpkg-dev autoconf libssl-dev zlib1g-dev ca-certificates
RUN apt-get install -y --no-install-recommends automake
RUN mkdir /build && cd /build && apt-get source openssh \
    && cd openssh-* && autoreconf -fi && ./configure --prefix=/usr --sysconfdir=/etc/ssh \
       --libexecdir=/usr/lib/openssh --with-privsep-path=/run/sshd \
       --with-privsep-user=sshd --without-pam --without-audit --without-selinux \
    && make -j2 sshd && cp sshd /build/sshd
RUN cd /build/openssh-* && dpkg-parsechangelog -S Version > /build/sshd-source-version

FROM ${BASE_IMAGE}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG NODE_VERSION=24.13.1
ARG NODE_DOWNLOAD_BASE=https://nodejs.org/dist
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-server openssh-client python3 supervisor xz-utils \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
RUN set -eu; case "$(dpkg --print-architecture)" in amd64) arch=x64;; arm64) arch=arm64;; *) exit 1;; esac; \
    file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 "${NODE_DOWNLOAD_BASE}/v${NODE_VERSION}/${file}" -o "/tmp/${file}"; \
    curl -fsSL --retry 3 --connect-timeout 20 --max-time 60 "${NODE_DOWNLOAD_BASE}/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/node-sha; \
    cd /tmp; grep "  ${file}$" node-sha | sha256sum -c -; \
    tar -xJf "$file" --strip-components=1 -C /usr/local; rm "$file" node-sha; \
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<19))process.exit(1)'
RUN npm install --global --registry="${NPM_REGISTRY}" @earendil-works/pi-coding-agent@1.5.0 \
    && npm cache clean --force && pi --version
RUN if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
    && groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash --password '*' agent \
    && install -d -m 0755 /ursi /opt/ursi/runtime /run/sshd /etc/ssh/authorized_keys \
    && install -d -o root -g agent -m 1770 /ursi/workspace \
    && printf '1\n' >/etc/ursi-image-level
COPY --from=sshd-build /build/sshd /usr/sbin/sshd
COPY --from=sshd-build /build/sshd-source-version /etc/ursi-sshd-source-version
COPY bootstrap.py /ursi/bootstrap
COPY healthcheck.py /ursi/healthcheck
COPY sshd_config /etc/ssh/sshd_config
RUN chmod 0755 /ursi/bootstrap /ursi/healthcheck
LABEL io.ursi.image-level="1" io.ursi.environment-profile="pi-execution"
ENV URSI_SESSION_BIND=0.0.0.0:8765 \
    URSI_SESSION_CONFIG_DIR=/run/ursi/config \
    URSI_WORKSPACE_ROOT=/ursi/workspace \
    URSI_SESSION_STATE_DIR=/ursi/workspace/.ursi-state \
    URSI_PI_BIN=/usr/local/bin/pi
WORKDIR /ursi/workspace
EXPOSE 2222 8765
HEALTHCHECK --interval=10s --timeout=8s --start-period=30s --retries=3 CMD ["/ursi/healthcheck"]
ENTRYPOINT ["/ursi/bootstrap"]
