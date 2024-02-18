FROM node

RUN mkdir /app
WORKDIR /app
COPY package.json index.js /app/
RUN npm install

CMD ["npm", "start"]
