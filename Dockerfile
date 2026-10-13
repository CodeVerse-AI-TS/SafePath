# SafePath — production image
#
# Node 24 is required: the data layer uses the built-in `node:sqlite`, which
# needs --experimental-sqlite on Node 22.5-23.3 and is stable from Node 24.
# There is no native module to compile, so no build toolchain is needed.
#
#   docker build -t safepath .
#   docker run -p 3000:3000 -v safepath-data:/data safepath
#
# The /data volume holds the SQLite database. Without it, reports, alerts and
# trips are lost on every redeploy.

FROM node:24-slim AS deps
WORKDIR /app
# Only the manifests, so this layer caches until dependencies actually change.
COPY package.json package-lock.json ./
# --omit=dev: puppeteer-core is a devDependency used only by the browser tests.
RUN npm ci --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    SAFEPATH_DB=/data/safepath.db

# Run as the unprivileged user the node image already provides.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
COPY --chown=node:node ds ./ds

# The volume mount point must be writable by the runtime user.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000

# The server seeds itself on first boot when the database is empty.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
