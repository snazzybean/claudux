FROM node:22-slim

# ttyd is not packaged for Debian - the upstream release binary is static
# and published per architecture, which is cheaper than building
# libwebsockets in here.
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ca-certificates curl procps \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) ttyd_arch=x86_64 ;; \
         arm64) ttyd_arch=aarch64 ;; \
         *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && npm install -g @anthropic-ai/claude-code

# Anyone who reaches the port gets a shell as this user - the same reason
# deploy/claudux.service sets User=. The container default would be root.
RUN useradd --create-home --shell /bin/bash claudux \
    # A named volume mounted here inherits the image path's ownership. Without
    # this the directory is created by Docker as root and `claudux` cannot
    # write access.json into it.
    && mkdir -p /home/claudux/.claudux \
    && chown claudux:claudux /home/claudux/.claudux
WORKDIR /app
COPY --chown=claudux:claudux . .
RUN npm ci --omit=dev

USER claudux

# USER does not set HOME, and config.js resolves every per-installation path
# through os.homedir() - which reads $HOME first. Left to the runtime it is
# either unset or still /root, and the second case is unwritable.
ENV HOME=/home/claudux
# $HOME would point at the container's own home, not at the mounted
# projects, leaving the "+ Add folder" dialog useless.
ENV PROJECTS_BROWSE_ROOT=/projects
EXPOSE 4001
CMD ["node", "src/server.js"]
