FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./backend/package.json
RUN cd backend && npm install --production

COPY backend/ ./backend/
COPY frontend/public/ ./frontend/public/

EXPOSE 3001

CMD ["node", "backend/server.js"]
