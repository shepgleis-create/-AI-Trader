FROM node:22-alpine
ENV NODE_ENV=production
ENV TRADING_MODE=RESEARCH_ONLY
ENV HEALTH_HOST=0.0.0.0
WORKDIR /srv/ai-trader-v2
COPY package.json stream-core.mjs coinbase-worker.mjs ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=40s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "coinbase-worker.mjs"]
