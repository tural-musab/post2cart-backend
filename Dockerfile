FROM node:20-alpine AS development

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

FROM node:20-alpine AS production

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

WORKDIR /app

COPY package*.json ./

RUN apk add --no-cache ffmpeg \
    && npm install --omit=dev

COPY --from=development /app/dist ./dist

CMD ["node", "dist/main"]
