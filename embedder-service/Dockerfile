FROM node:20-slim

WORKDIR /app

COPY package.json .
COPY src/ ./src/

# No npm install needed — zero production dependencies (pure Node built-ins + fetch)
# If you add npm dependencies later: RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/server.js"]