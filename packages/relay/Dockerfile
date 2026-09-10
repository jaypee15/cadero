FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mobile/package.json packages/mobile/package.json
COPY scripts/postinstall.sh scripts/postinstall.sh
RUN npm ci --workspace=@cadero/protocol --workspace=@cadero/relay --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN npm run build --workspace=@cadero/protocol && npm run build --workspace=@cadero/relay

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY --from=build /app/packages/relay/package.json ./packages/relay/package.json
CMD ["node", "packages/relay/dist/main.js"]
