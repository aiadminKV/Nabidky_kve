# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./

# NEXT_PUBLIC_* vars are baked in at build time
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
# NEXT_PUBLIC_BACKEND_URL intentionally not set — defaults to http://localhost:3001
# (see next.config.ts rewrites) since backend runs internally in the same container

RUN npm run build

# ── Stage 2: Build backend ───────────────────────────────────────────────────
FROM node:20-slim AS backend-builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ── Stage 3: Production image ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Backend: install only production deps, then copy compiled JS
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY --from=backend-builder /app/backend/dist ./backend/dist

# Frontend: Next.js standalone output
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/frontend/public ./frontend/public

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"

# Backend runs on internal port 3001 (never exposed publicly).
# Next.js uses Railway's injected $PORT (public).
# Browser calls /api/* → Next.js rewrite → localhost:3001 (internal).
CMD ["sh", "-c", "PORT=3001 node backend/dist/index.js & node frontend/server.js"]
