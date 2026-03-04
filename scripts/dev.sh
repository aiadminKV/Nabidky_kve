#!/bin/bash
set -e

echo "→ Installing dependencies..."

cd "$(dirname "$0")/.."

if [ ! -d "backend/node_modules" ]; then
  echo "  Installing backend..."
  (cd backend && npm install)
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "  Installing frontend..."
  (cd frontend && npm install)
fi

if [ ! -d "scripts/node_modules" ]; then
  echo "  Installing scripts..."
  (cd scripts && npm install)
fi

echo ""
echo "→ Starting backend on port 3001..."
cd backend
npx tsx watch src/index.ts &
BACKEND_PID=$!
cd ..

echo "→ Starting frontend on port 3000..."
cd frontend
npx next dev --turbopack &
FRONTEND_PID=$!
cd ..

echo ""
echo "✓ Running:"
echo "  Backend  → http://localhost:3001"
echo "  Frontend → http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both."

cleanup() {
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
}
trap cleanup EXIT INT TERM
wait
