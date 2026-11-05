FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .

# Local uploads (only used when Spaces is not configured) must be writable by the app user.
RUN mkdir -p uploads && chown node:node uploads
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health >/dev/null || exit 1

# node directly (not npm) so SIGTERM reaches the app and it can shut down cleanly.
CMD ["node", "src/server.js"]
