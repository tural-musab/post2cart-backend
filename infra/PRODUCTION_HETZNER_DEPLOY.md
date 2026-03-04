# Post2Cart Hetzner Production Deploy Template

Bu runbook, Post2Cart backend stack'ini `api.post2cart.com` ve `media.post2cart.com` altında izole şekilde deploy etmek için hazırlanmıştır.

## 1) Hedef Mimari
- Backend: `post2cart-backend` container (`127.0.0.1:3010 -> 3100`)
- MinIO API: `post2cart-minio` (`127.0.0.1:9010 -> 9000`)
- MinIO Console: `127.0.0.1:9011 -> 9001` (public expose edilmez)
- Nginx ingress:
  - `api.post2cart.com -> 127.0.0.1:3010`
  - `media.post2cart.com -> 127.0.0.1:9010`
- n8n internal erişim: external docker network `n8n_n8n-network` üzerinden `http://post2cart-backend:3100`

## 2) Cloudflare Gereksinimleri
Cloudflare tarafında zone: `post2cart.com`

- DNS:
  - `A api -> <production_ip>` (Proxied ON)
  - `A media -> <production_ip>` (Proxied ON)
- SSL/TLS mode: `Full (strict)`
- Origin Certificate üretimi:
  - Hostnames: `api.post2cart.com`, `media.post2cart.com`
  - Key format: `PEM`

Sunucuda dosyalar:

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/post2cart.com.pem
sudo nano /etc/ssl/cloudflare/post2cart.com.key
sudo chmod 600 /etc/ssl/cloudflare/post2cart.com.key
sudo chmod 644 /etc/ssl/cloudflare/post2cart.com.pem
```

## 3) Repo ve Env Hazırlığı (Production Server)

```bash
sudo mkdir -p /opt/projects
cd /opt/projects

# repo yoksa
sudo git clone https://github.com/tural-musab/post2cart-backend.git

cd /opt/projects/post2cart-backend
sudo git checkout main
sudo git pull --ff-only origin main
```

`infra/.env.prod.example` dosyasını referans alarak `/opt/projects/post2cart-backend/.env.production` oluştur:

```bash
cp infra/.env.prod.example .env.production
nano .env.production
```

Zorunlu alanlar:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY` (64 hex)
- `N8N_INTERNAL_TOKEN`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `PUBLIC_STORE_BASE_URL=https://post2cart.com`
- `MINIO_PUBLIC_BASE_URL=https://media.post2cart.com`

## 4) Docker Network Kontrolü
`n8n` stack ile paylaşılan external network mevcut olmalı:

```bash
docker network ls | grep n8n_n8n-network || docker network create n8n_n8n-network
```

## 5) Uygulama Deploy

```bash
cd /opt/projects/post2cart-backend
./infra/scripts/prod-deploy.sh
```

Manuel alternatif:

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f infra/docker-compose.prod.yml ps
```

## 6) Nginx VHost Kurulumu

```bash
sudo cp infra/nginx/api.post2cart.com.conf /etc/nginx/sites-available/api.post2cart.com.conf
sudo cp infra/nginx/media.post2cart.com.conf /etc/nginx/sites-available/media.post2cart.com.conf

sudo ln -sf /etc/nginx/sites-available/api.post2cart.com.conf /etc/nginx/sites-enabled/api.post2cart.com.conf
sudo ln -sf /etc/nginx/sites-available/media.post2cart.com.conf /etc/nginx/sites-enabled/media.post2cart.com.conf

sudo nginx -t
sudo systemctl reload nginx
```

## 7) Smoke Test

```bash
# Local (origin)
curl -i http://127.0.0.1:3010/
curl -i http://127.0.0.1:9010/

# Public (Cloudflare)
curl -I https://api.post2cart.com/
curl -I https://media.post2cart.com/
```

Beklenenler:
- `https://api.post2cart.com/` -> 200
- `https://media.post2cart.com/` -> 200/403 (MinIO behavior'a göre), TLS valid

## 8) n8n Tarafı
n8n environment içinde:
- `N8N_INTERNAL_TOKEN=<same token>`
- `OPENAI_API_KEY=<required>`

Workflow import dosyaları:
- `infra/n8n-workflows/master_schedule_workflow.json`
- `infra/n8n-workflows/sub_workflow_instagram.json`

## 9) Rollback

```bash
cd /opt/projects/post2cart-backend
git checkout <previous_commit>
docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d --build
```

Nginx rollback:

```bash
sudo rm -f /etc/nginx/sites-enabled/api.post2cart.com.conf
sudo rm -f /etc/nginx/sites-enabled/media.post2cart.com.conf
sudo nginx -t && sudo systemctl reload nginx
```
