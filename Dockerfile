FROM node:24-slim

# ttyd is not packaged for Debian - the upstream release binary is static
# and published per architecture, which is cheaper than building
# libwebsockets in here.
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH

# git, because the repositories a session works on are the point of this
# image and Claude Code's core workflows need it - node:24-slim carries none.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tmux ca-certificates curl git procps \
    && rm -rf /var/lib/apt/lists/* \
    # Pinned by content, not only by tag: a release asset can be replaced
    # under its tag, and strangers run this image. The hashes belong to
    # TTYD_VERSION above and move with it.
    && case "$TARGETARCH" in \
         amd64) ttyd_arch=x86_64 ttyd_sha=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;; \
         arm64) ttyd_arch=aarch64 ttyd_sha=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;; \
         *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
    && echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd \
    && npm install -g @anthropic-ai/claude-code

# Anyone who reaches the port gets a shell as this user - the same reason
# deploy/claudux.service sets User=. The container default would be root.
#
# uid 1000, which the base image's own `node` user holds and therefore gives
# up here: a host user at 1000 has to stay able to write the files under a
# mounted -v ~/code:/projects. --create-home leaves /home/claudux to
# claudux, so the volume the README mounts there inherits that ownership and
# the app creates .claudux under it on first write.
RUN userdel -r node \
    && useradd --create-home --uid 1000 --shell /bin/bash claudux \
    # PROJECTS_BROWSE_ROOT below is resolved through realpath, so without
    # the directory a run without that mount answers 400 on "+ Add folder".
    && mkdir -p /projects \
    && chown claudux:claudux /projects
WORKDIR /app
# Deliberately no --chown: /app stays root-owned, so a session cannot
# rewrite the code the next container start runs. npm ci runs as root here
# either way.
COPY . .
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
