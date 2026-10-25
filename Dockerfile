# syntax=docker/dockerfile:1
# Obraz produkcyjny HnP Planner. Dane (config, sekrety, SQLite + WAL) trafiają do /data —
# zamontuj tam nazwany wolumen, aby przetrwały usunięcie/odtworzenie kontenera.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Narzędzia do zbudowania better-sqlite3, gdyby prebuilt binarka była niedostępna.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json tsconfig.web.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HNP_PLANNER_HOME=/data \
    HNP_PORT=4317
WORKDIR /app
# Kod i zależności należą do root (tylko do odczytu dla użytkownika aplikacji).
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Katalog danych należy do nieuprzywilejowanego użytkownika „node” (uid 1000), uprawnienia 0700.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 4317
# Domyślnie aplikacja nasłuchuje na 127.0.0.1 także w kontenerze. Aby była osiągalna przez
# opublikowany port, ustaw jawnie HNP_BIND_HOST=0.0.0.0 (robi to compose.yaml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HNP_PORT||4317)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
