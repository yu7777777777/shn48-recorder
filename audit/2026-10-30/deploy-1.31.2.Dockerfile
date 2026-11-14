ARG BASE_IMAGE=shn48-shn48:rollback-1.31.1-20261030
FROM ${BASE_IMAGE}
LABEL org.opencontainers.image.version="1.31.2" org.opencontainers.image.revision="frontend-redesign-20261030" description="48tools 1.31.2 - frontend visual and information cleanup"
USER root
RUN rm -rf /app/client/dist
COPY client/dist/ /app/client/dist/
COPY VERSION /app/VERSION
RUN node -e "const fs=require('fs');for(const p of ['/app/server/package.json','/app/server/package-lock.json']){if(!fs.existsSync(p))continue;const d=JSON.parse(fs.readFileSync(p,'utf8'));const old=d.version;d.version='1.31.2';if(d.packages&&d.packages[''])d.packages[''].version='1.31.2';if(d.description)d.description=d.description.replaceAll(old,'1.31.2');fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n')}"
