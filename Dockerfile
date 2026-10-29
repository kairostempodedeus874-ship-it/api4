FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

# O Baileys baixa uma dependência (libsignal) direto de um repositório Git.
# Sem o pacote "git" o npm falha com "spawn git ENOENT" durante o build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Garante que dependências Git sejam baixadas por HTTPS (sem precisar de chave SSH).
RUN git config --global url."https://github.com/".insteadOf "git@github.com:"

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# 8080 é a porta que o Fly usa por padrão na checagem de saúde.
# 3001 fica exposta também para docker-compose/VPS.
EXPOSE 8080 3001
CMD ["node", "index.js"]