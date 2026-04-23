# 🚀 Інструкція деплою проекту Fillando

## Опис проекту

**Fillando** — платформа для 3D друку. Складається з:

- **Бекенд**: NestJS + MongoDB (окремий репозиторій)
- **Фронтенд**: Next.js 16 з App Router та SSR (окремий репозиторій)
- **База даних**: MongoDB 4.4
- **Сервер**: домашній Ubuntu сервер зі статичним IP
- **Домен**: fillando.com з HTTPS (Let's Encrypt)
- **CI/CD**: GitHub Actions з деплоєм через SSH

**Архітектура на сервері:**

```
Internet → Nginx (443/80) → Next.js :3000 (фронтенд)
                          → NestJS  :4000 (бекенд)
                          → MongoDB :27017 (внутрішня мережа Docker)
```

---

## Передумови

- Ubuntu сервер вдома зі статичним IP
- Статичний IP куплений і налаштована переадресація портів 80 і 443 в роутері
- Домен куплений і DNS A-записи вказують на статичний IP
- Два GitHub репозиторії: `fillando-be` і `fillando-fe`
- На локальному Mac є доступ до сервера через SSH

---

## Крок 1 — Оновлення системи

```bash
sudo apt update && sudo apt upgrade -y
```

**Що робить:** оновлює всі пакети Ubuntu до актуальних версій. Обов'язково робити перед встановленням нового ПЗ.

---

## Крок 2 — Встановлення Docker

```bash
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Додаємо юзера в групу docker щоб не писати `sudo` кожен раз:

```bash
sudo usermod -aG docker $USER
```

**Обов'язково перелогінитись після цього:**

```bash
exit
ssh user@your-ip
```

Перевірка:

```bash
docker --version
docker compose version
```

**Що робить:** встановлює Docker Engine і Docker Compose v2 з офіційного репозиторію Docker.

---

## Крок 3 — Встановлення Nginx та Certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Перевірка що Nginx запустився:

```bash
sudo systemctl status nginx
```

Має показати `active (running)`.

**Що робить:** встановлює Nginx як reverse proxy і Certbot для автоматичного отримання SSL сертифікату від Let's Encrypt.

---

## Крок 4 — Генерація SSH ключів для GitHub Actions

Виконується на **локальному Mac**, не на сервері:

```bash
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github_actions
```

На питання про passphrase — натиснути Enter (без пароля).

Переглянути ключі:

```bash
cat ~/.ssh/github_actions      # приватний ключ → піде в GitHub Secrets
cat ~/.ssh/github_actions.pub  # публічний ключ → піде на сервер
```

**Що робить:** створює пару SSH ключів спеціально для GitHub Actions. GitHub буде використовувати приватний ключ щоб підключатись до сервера.

---

## Крок 5 — Додавання публічного ключа на сервер

На **сервері**:

```bash
echo "вміст github_actions.pub" >> ~/.ssh/authorized_keys
cat ~/.ssh/authorized_keys
```

Має бути два записи: твій основний ключ і новий `github-actions`.

**Що робить:** додає публічний ключ в список дозволених для підключення до сервера. GitHub Actions зможе підключатись використовуючи відповідний приватний ключ.

> ⚠️ **Увага:** виконувати саме на сервері, не локально.

---

## Крок 6 — Створення папок для проєктів

На сервері:

```bash
sudo mkdir -p /srv/fillando-api
sudo mkdir -p /srv/fillando-frontend
sudo chown $USER:$USER /srv/fillando-api
sudo chown $USER:$USER /srv/fillando-frontend
```

Перевірка:

```bash
ls -la /srv/
```

**Що робить:** створює директорії де будуть зберігатись репозиторії проєктів. `chown` передає власність твоєму юзеру щоб не потрібен був `sudo` для роботи з файлами.

---

## Крок 7 — Налаштування SSH ключів для GitHub (Deploy Keys)

Генерація ключів **на сервері** для клонування репозиторіїв:

```bash
ssh-keygen -t ed25519 -C "fillando-server" -f ~/.ssh/github_deploy
ssh-keygen -t ed25519 -C "fillando-server-frontend" -f ~/.ssh/github_deploy_frontend
```

Додаємо публічні ключі в GitHub:

- `cat ~/.ssh/github_deploy.pub` → бек-репо: **Settings → Deploy keys → Add deploy key**
- `cat ~/.ssh/github_deploy_frontend.pub` → фронт-репо: **Settings → Deploy keys → Add deploy key**

Налаштовуємо SSH config на сервері:

```bash
nano ~/.ssh/config
```

```
Host github-be
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_deploy

Host github-fe
    HostName github.com
    User git
    IdentityFile ~/.ssh/github_deploy_frontend
```

Перевірка:

```bash
ssh -T git@github-be
ssh -T git@github-fe
```

Обидва мають показати `Hi ... You've successfully authenticated`.

**Що робить:** один ключ не можна додати як deploy key в два репо — тому генеруємо окремий для кожного. SSH config вказує який ключ використовувати для якого репо.

---

## Крок 8 — Клонування репозиторіїв

```bash
git clone git@github-be:vvbogdanovih/fillando-be.git /srv/fillando-api
git clone git@github-fe:vvbogdanovih/fillando-fe.git /srv/fillando-frontend
```

**Що робить:** клонує репозиторії в підготовлені папки використовуючи SSH ключі з попереднього кроку.

---

## Крок 9 — Файли для продакшену (додаються в репозиторії)

### Бекенд

**`Dockerfile.prod`** в корені бек-репо:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
EXPOSE 4000
CMD ["node", "dist/main"]
```

**`docker-compose.prod.yml`** в корені бек-репо:

```yaml
services:
    api:
        build:
            context: .
            dockerfile: Dockerfile.prod
        container_name: fillando-api
        restart: unless-stopped
        env_file: .env.prod
        ports:
            - '4000:4000'
        depends_on:
            mongo:
                condition: service_healthy
        networks:
            - fillando-net

    mongo:
        image: mongo:4.4
        container_name: fillando-mongo
        restart: unless-stopped
        env_file: .env.prod
        environment:
            MONGO_INITDB_ROOT_USERNAME: ${DOCKER_MONGO_USER}
            MONGO_INITDB_ROOT_PASSWORD: ${DOCKER_MONGO_PASSWORD}
            MONGO_INITDB_DATABASE: ${DOCKER_MONGO_DB}
        volumes:
            - mongo-data:/data/db
        healthcheck:
            test: ['CMD', 'mongo', '--eval', "db.adminCommand('ping')"]
            interval: 5s
            timeout: 5s
            retries: 5
        networks:
            - fillando-net

networks:
    fillando-net:

volumes:
    mongo-data:
```

> ⚠️ **Важливо:** використовувати `mongo:4.4` а не `mongo:7` — процесор Intel Core 2 не підтримує AVX інструкції які потрібні MongoDB 5.0+. Також healthcheck використовує `mongo` а не `mongosh` — в 4.4 є тільки `mongo`.

> ⚠️ **Важливо:** Mongo не відкриває порт назовні (`ports:` відсутній) — тільки внутрішня мережа Docker.

### Фронтенд

**`Dockerfile.prod`** в корені фронт-репо:

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN yarn build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder /app/node_modules/@img ./node_modules/@img
EXPOSE 3000
CMD ["node", "server.js"]
```

**`docker-compose.prod.yml`** в корені фронт-репо:

```yaml
services:
    frontend:
        build:
            context: .
            dockerfile: Dockerfile.prod
            args:
                NEXT_PUBLIC_API_BASE_URL: https://fillando.com/api
        container_name: fillando-frontend
        restart: unless-stopped
        env_file: .env.prod
        ports:
            - '3000:3000'
```

**`next.config.ts`** — додати `output: 'standalone'`:

```typescript
const nextConfig: NextConfig = {
	output: 'standalone'
	// решта налаштувань...
}
```

> ⚠️ **Важливо:** `NEXT_PUBLIC_*` змінні вбудовуються під час `yarn build` тому треба передавати їх через `ARG` в Dockerfile, а не тільки через `env_file`. Значення хардкодиться в `args` бо це публічна змінна.

> ⚠️ **Важливо:** сторінки які роблять fetch до API під час білду потребують `export const dynamic = 'force-dynamic'` — інакше білд падає бо API недоступне під час збірки.

---

## Крок 10 — Створення .env.prod файлів на сервері

**.env.prod для бекенду** (`/srv/fillando-api/.env.prod`):

```bash
nano /srv/fillando-api/.env.prod
```

```properties
DATABASE_URL=mongodb://fillando:fillandopassword@fillando-mongo:27017/fillando?authSource=admin

JWT_SECRET=your_secret
JWT_EXPIRATION=15
ACCSESS_TOKEN_NAME=access_token

REFRESH_JWT_SECRET=your_refresh_secret
REFRESH_JWT_EXPIRATION=10080
REFRESH_TOKEN_NAME=refresh_token

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=https://fillando.com/api/auth/google/callback

AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=eu-north-1
AWS_S3_BUCKET_NAME=fillando
AWS_S3_PUBLIC_URL=https://fillando.s3.eu-north-1.amazonaws.com

RESEND_API_KEY=your_key
PASSWORD_PEPPER=your_pepper

FRONTEND_URL=https://fillando.com
PORT=4000
NODE_ENV=production
LOG_LEVEL=info

DOCKER_MONGO_USER=fillando
DOCKER_MONGO_PASSWORD=fillandopassword
DOCKER_MONGO_DB=fillando
DOCKER_DB_PORT_EXTERNAL=27018
```

> ⚠️ **Важливо:** `DATABASE_URL` використовує `fillando-mongo` (назва контейнера) замість `localhost` — контейнери спілкуються між собою через внутрішню Docker мережу.

**.env.prod для фронтенду** (`/srv/fillando-frontend/.env.prod`):

```bash
nano /srv/fillando-frontend/.env.prod
```

```properties
NEXT_PUBLIC_API_BASE_URL=https://fillando.com/api
```

**.env.prod файли ніколи не комітяться в репозиторій** — вони створюються вручну на сервері.

---

## Крок 11 — Налаштування Nginx

```bash
sudo nano /etc/nginx/sites-available/fillando
```

```nginx
server {
    listen 80;
    server_name fillando.com www.fillando.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name fillando.com www.fillando.com;

    ssl_certificate /etc/letsencrypt/live/fillando.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fillando.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffers 8 16k;
        proxy_buffer_size 32k;
        proxy_busy_buffers_size 64k;
    }

    location /api/ {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Активуємо конфіг:

```bash
sudo ln -s /etc/nginx/sites-available/fillando /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

> ⚠️ **Важливо:** `proxy_pass http://localhost:4000` — **без слешу в кінці**. Слеш в кінці (`http://localhost:4000/`) прибирає `/api/` prefix і бекенд не знаходить роути.

**Що робить:** Nginx приймає всі запити і перенаправляє: `/api/*` → NestJS на порту 4000, решта → Next.js на порту 3000.

---

## Крок 12 — Отримання SSL сертифікату

Спочатку переконайся що DNS вже вказує на сервер:

```bash
nslookup fillando.com
```

Має показати твій статичний IP. Якщо ні — чекай поки DNS поширюється (від 5 хвилин до кількох годин).

```bash
sudo certbot --nginx -d fillando.com -d www.fillando.com
```

Certbot сам оновить Nginx конфіг і налаштує автоматичне оновлення сертифікату.

> ⚠️ **Можлива помилка:** `DNS problem: SERVFAIL` — DNS ще не поширився. Зачекай і спробуй знову.

---

## Крок 13 — Перший запуск бекенду

```bash
cd /srv/fillando-api
docker compose -f docker-compose.prod.yml up -d --build
```

Перевірка:

```bash
docker logs fillando-api --tail 20
curl http://localhost:4000/api/categories
```

> ⚠️ **Можлива помилка: MongoDB Authentication failed** — юзер не створився автоматично. Вирішення — створити вручну:

```bash
docker exec -it fillando-mongo mongo --eval "
db.getSiblingDB('admin').createUser({
  user: 'fillando',
  pwd: 'fillandopassword',
  roles: [
    { role: 'readWrite', db: 'fillando' },
    { role: 'dbAdmin', db: 'fillando' }
  ]
})"
docker restart fillando-api
```

> ⚠️ **Якщо проблема повторюється після повторного запуску** — видалити volume і запустити знову:

```bash
docker compose -f docker-compose.prod.yml down -v
docker volume ls  # переконатись що порожньо
docker compose -f docker-compose.prod.yml up -d --build
# якщо юзер знову не створився — повторити ручне створення вище
```

---

## Крок 14 — Перший запуск фронтенду

```bash
cd /srv/fillando-frontend
docker compose -f docker-compose.prod.yml up -d --build
```

Перевірка:

```bash
curl http://localhost:3000
```

---

## Крок 15 — Налаштування CI/CD (GitHub Actions)

### Секрети в GitHub

Додати в кожне репо (**Settings → Secrets and variables → Actions → New repository secret**):

| Секрет     | Значення                                         |
| ---------- | ------------------------------------------------ |
| `SSH_HOST` | статичний IP сервера                             |
| `SSH_USER` | ім'я юзера (наприклад `vlad`)                    |
| `SSH_KEY`  | вміст `~/.ssh/github_actions` (з локального Mac) |
| `SSH_PORT` | `22`                                             |

Отримати приватний ключ на Mac:

```bash
cat ~/.ssh/github_actions | pbcopy
```

> ⚠️ **Важливо:** `SSH_PORT` вводити як просто `22` без пробілів і переносів рядка. `SSH_KEY` має містити повний ключ включно з `-----BEGIN OPENSSH PRIVATE KEY-----` і `-----END OPENSSH PRIVATE KEY-----`.

### Workflow для бекенду

`.github/workflows/deploy.yml` в бек-репо:

```yaml
name: Deploy Backend

on:
    push:
        branches: [master]

jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - name: Deploy via SSH
              uses: appleboy/ssh-action@v1
              with:
                  host: ${{ secrets.SSH_HOST }}
                  username: ${{ secrets.SSH_USER }}
                  key: ${{ secrets.SSH_KEY }}
                  port: ${{ secrets.SSH_PORT }}
                  script: |
                      cd /srv/fillando-api
                      git pull origin master
                      docker compose -f docker-compose.prod.yml build --no-cache api
                      docker compose -f docker-compose.prod.yml up -d --no-deps api
```

### Workflow для фронтенду

`.github/workflows/deploy.yml` в фронт-репо:

```yaml
name: Deploy Frontend

on:
    push:
        branches: [master]

jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - name: Deploy via SSH
              uses: appleboy/ssh-action@v1
              with:
                  host: ${{ secrets.SSH_HOST }}
                  username: ${{ secrets.SSH_USER }}
                  key: ${{ secrets.SSH_KEY }}
                  port: ${{ secrets.SSH_PORT }}
                  script: |
                      cd /srv/fillando-frontend
                      git pull origin master
                      docker compose -f docker-compose.prod.yml build --no-cache frontend
                      docker compose -f docker-compose.prod.yml up -d --no-deps frontend
```

> `--no-deps` — важливо для беку щоб не перезапускати Mongo при кожному деплої.

---

## Доступ до MongoDB з локальної мережі (Compass)

Сервер знаходиться в тій самій домашній мережі — підключатись через локальний IP:

```
mongodb://fillando:fillandopassword@192.168.1.168:27017/fillando?authSource=admin
```

Для цього треба відкрити порт в `docker-compose.prod.yml` беку:

```yaml
mongo:
    ports:
        - '27017:27017'
```

І дозволити підключення через firewall тільки з локальної мережі:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 27017
```

---

## Корисні команди

```bash
# Переглянути логи
docker logs fillando-api --tail 50
docker logs fillando-frontend --tail 50
docker logs fillando-mongo --tail 50

# Перезапустити контейнер
docker restart fillando-api
docker restart fillando-frontend

# Статус контейнерів
docker ps

# Зупинити все
cd /srv/fillando-api && docker compose -f docker-compose.prod.yml down
cd /srv/fillando-frontend && docker compose -f docker-compose.prod.yml down

# Оновити вручну без CI/CD
cd /srv/fillando-api
git pull origin master
docker compose -f docker-compose.prod.yml build --no-cache api
docker compose -f docker-compose.prod.yml up -d --no-deps api

# Перевірити Nginx конфіг
sudo nginx -t
sudo systemctl reload nginx
```
