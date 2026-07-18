FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c

# Node 22.x — core runs .ts via native type stripping (needs >=22.18).
ARG NODE_VERSION=22.22.0
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
