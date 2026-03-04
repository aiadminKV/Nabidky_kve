# ── Stage 1: Build backend ──────────────────────────────────────────────────
FROM node:20-slim AS backend-builder

WORKDIR /app/backend
COPY backend/.npmrc backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ── Stage 2: Build frontend ────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

# ── Stage 3: Production ────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Backend: compiled JS + production deps
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/package*.json ./backend/
COPY --from=backend-builder /app/backend/.npmrc ./backend/
RUN cd backend && npm ci --omit=dev

# Frontend: Next.js standalone (includes node_modules)
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"

# Next.js uses $PORT (set by Railway), backend fixed on 3001
CMD ["sh", "-c", "PORT=3001 node backend/dist/index.js & cd frontend && node server.js"]
