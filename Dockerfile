FROM node:20.19.2-slim

WORKDIR /app

COPY BankAPICollect/package*.json ./

RUN npm install

COPY BankAPICollect/ ./

RUN mkdir -p /data

VOLUME /data

CMD ["node", "update.js"]
