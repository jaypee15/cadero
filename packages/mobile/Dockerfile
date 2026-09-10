FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mobile/package.json packages/mobile/package.json
COPY scripts/postinstall.sh scripts/postinstall.sh
RUN npm ci --workspace=@cadero/protocol --workspace=@cadero/mobile --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/mobile packages/mobile
RUN npm run build --workspace=@cadero/protocol && npm run build --workspace=@cadero/mobile

FROM nginx:1.27-alpine
COPY packages/mobile/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/mobile/out /usr/share/nginx/html
EXPOSE 80
