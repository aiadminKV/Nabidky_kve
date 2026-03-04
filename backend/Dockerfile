FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
COPY .npmrc* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim

WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.npmrc* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
