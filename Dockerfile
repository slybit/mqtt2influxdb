FROM node:carbon-alpine

# Create app directory
WORKDIR /usr/src/app

COPY package.json ./

RUN npm install

# Bundle app source
COPY *.js ./

USER node:node

CMD [ "npm", "start" ]
