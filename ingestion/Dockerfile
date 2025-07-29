FROM node:20-alpine

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
CMD ["npm","run","start"]
