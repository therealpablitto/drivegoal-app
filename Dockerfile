# ─── Build Backend ────────────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --legacy-peer-deps

COPY backend/ ./
RUN npm run build && npx prisma generate


# ─── Production ───────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY --from=backend-builder /app/backend/package.json ./package.json
COPY --from=backend-builder /app/backend/prisma ./prisma

# Pre-built frontend (committed to repo, avoids OOM on Railway free plan)
COPY frontend/dist ./public

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
