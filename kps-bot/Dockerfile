FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV NODE_ENV=production

CMD ["npm", "start"]
