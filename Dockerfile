# LocalGrounds: one Node process serves the web app and the game WebSocket on a single port.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Map tile settings are baked into the web build. Override with --build-arg (see README).
ARG VITE_TILE_STYLE=satellite
ARG VITE_TILE_URL=
ARG VITE_TILE_KEY=
ARG VITE_TILE_ATTRIBUTION=
ARG VITE_TILE_LABELS=
ENV VITE_TILE_STYLE=$VITE_TILE_STYLE VITE_TILE_URL=$VITE_TILE_URL VITE_TILE_KEY=$VITE_TILE_KEY \
    VITE_TILE_ATTRIBUTION=$VITE_TILE_ATTRIBUTION VITE_TILE_LABELS=$VITE_TILE_LABELS
RUN npm run web:build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["npx", "tsx", "src/server/main.ts"]
