# ---- Stage 1: fetch front-end libraries so the image works without Internet access
FROM node:20-alpine AS vendor
WORKDIR /build
RUN npm install --no-audit --no-fund --omit=dev echarts@5.5.1 leaflet@1.9.4 \
 && mkdir -p out/images \
 && cp node_modules/echarts/dist/echarts.min.js out/ \
 && cp node_modules/leaflet/dist/leaflet.js out/leaflet.min.js \
 && cp node_modules/leaflet/dist/leaflet.css out/leaflet.min.css \
 && cp node_modules/leaflet/dist/images/* out/images/

# ---- Stage 2: runtime (no npm dependencies needed)
FROM node:20-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY --chown=node:node package.json server.js demo-data.js ./
COPY --chown=node:node public ./public
COPY --from=vendor --chown=node:node /build/out ./public/vendor
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
