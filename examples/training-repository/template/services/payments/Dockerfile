# Build context is the repository root, because the image also needs contracts/proto.
FROM node:20-alpine AS build
WORKDIR /app/services/payments
COPY services/payments/package.json services/payments/package-lock.json ./
RUN npm ci
COPY services/payments/ ./
RUN npx prisma generate && npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/payments
COPY services/payments/package.json services/payments/package-lock.json ./
RUN npm ci --omit=dev
COPY services/payments/prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/services/payments/dist ./dist
COPY contracts /app/contracts
EXPOSE 8081 50051
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
