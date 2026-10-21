# Build context is the repository root, because the image also needs contracts/proto.
FROM node:20-alpine AS build
WORKDIR /app/services/checkout
COPY services/checkout/package.json services/checkout/package-lock.json ./
RUN npm ci
COPY services/checkout/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/services/checkout
COPY services/checkout/package.json services/checkout/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/services/checkout/dist ./dist
COPY contracts /app/contracts
EXPOSE 8083
CMD ["node", "dist/index.js"]
