FROM node:15.12.0-alpine3.13

WORKDIR /usr/src/server-loadpolus

ARG NPM_AUTH_TOKEN

EXPOSE 22023/udp \
       22024/udp

ENV NODE_ENV=development

ENV NP_REDIS_PORT \
    NP_DROPLET_PORT \
    NP_REDIS_HOST \
    NP_REDIS_PASSWORD \
    NP_DROPLET_ADDRESS

COPY --chown=node:node .npmrc_docker \
                       ./.npmrc
COPY --chown=node:node package.json \
                       package-lock.json \
                       tsconfig.json \
                       ./
COPY --chown=node:node bin \
                       ./bin

COPY --chown=node:node src \
                       ./src

RUN ["npm", "ci"]

USER node

ENTRYPOINT ["npm", "start"]
