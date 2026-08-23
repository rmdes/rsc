FROM cloudron/base:5.1.0@sha256:1c0666c9abe9e2090d33686826d4e97769b799124573118d41e0d7485135748e

# Node 22.x — core runs .ts via native type stripping (needs >=22.18).
ARG NODE_VERSION=22.22.2
RUN mkdir -p /usr/local/node-$NODE_VERSION && \
    curl -fsSL https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz \
      | tar zxf - --strip-components 1 -C /usr/local/node-$NODE_VERSION
ENV PATH="/usr/local/node-$NODE_VERSION/bin:$PATH"

RUN mkdir -p /app/code /app/pkg /app/data
WORKDIR /app/code

# Workspace install (no NODE_ENV yet — web build needs devDeps).
COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY web/package.json web/package.json
# mcp/ is a declared workspace (root package.json) and web's /mcp route imports
# @rsc/mcp/src/tools.ts. Without this manifest `npm ci` installs none of mcp's
# dependencies, so the production image — the deployment path for every live
# instance — would ship without the MCP SDK.
COPY mcp/package.json mcp/package.json
# npm@12: every earlier npm's `ci` (10 and 11 both, tested) ignores
# better-sqlite3 v13's gypfile:false and forces a node-gyp compile; npm 12 uses
# the tarball-bundled prebuild. Installed by REPLACING the bundled npm from the
# registry tarball — `npm i -g npm` upgrading itself from 10→12 corrupts its own
# tree mid-reify ("Cannot find module 'promise-retry'", reproduced in this build).
RUN curl -fsSL https://registry.npmjs.org/npm/-/npm-12.0.2.tgz | tar zxf - -C /tmp && \
    rm -rf /usr/local/node-$NODE_VERSION/lib/node_modules/npm && \
    mv /tmp/package /usr/local/node-$NODE_VERSION/lib/node_modules/npm
RUN chown -R cloudron:cloudron /app/code && \
    gosu cloudron:cloudron npm ci

# App source, then build web (adapter-node → web/build).
COPY . /app/code
RUN chown -R cloudron:cloudron /app/code && \
    gosu cloudron:cloudron npm run build -w web

ENV NODE_ENV=production

# Writable data dir: symlink in the Dockerfile (read-only at runtime).
RUN rm -rf /app/code/core/data && ln -s /app/data /app/code/core/data

# Stage package files to read-only /app/pkg.
COPY cloudron/start.sh cloudron/nginx.conf cloudron/proxy_params /app/pkg/
RUN chmod +x /app/pkg/start.sh

CMD [ "/app/pkg/start.sh" ]
