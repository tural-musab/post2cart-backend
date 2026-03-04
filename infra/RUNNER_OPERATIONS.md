# Post2Cart Runner Operations

## DevServer self-hosted runner
- Name: `devserver-post2cart-backend`
- Labels: `self-hosted`, `Linux`, `X64`, `devserver`, `post2cart`
- Service:
  - `actions.runner.tural-musab-post2cart-backend.devserver-post2cart-backend.service`
- Runner directory:
  - `/home/dev/actions-runner-post2cart-backend`

## Health checks (systemd)
- Script:
  - `/usr/local/bin/post2cart-runner-healthcheck.sh`
- Env file:
  - `/etc/post2cart-runner-monitor.env`
- Timer/service:
  - `post2cart-runner-healthcheck.timer` (every 5 min)
  - `post2cart-runner-healthcheck.service`

## Weekly refresh
- `post2cart-runner-weekly-restart.timer`
- `post2cart-runner-weekly-restart.service`
- Schedule: Sunday 04:15 (server timezone)

## Alerting
`/etc/post2cart-runner-monitor.env` içinde opsiyonel webhook:

```env
ALERT_WEBHOOK_URL=https://your-webhook-endpoint
```

Healthcheck bir problem yakalarsa webhook'a JSON POST atar.

## Useful commands

```bash
# Runner service state
sudo systemctl status actions.runner.tural-musab-post2cart-backend.devserver-post2cart-backend.service

# Timers
sudo systemctl list-timers --all | grep post2cart-runner

# Force one healthcheck run
sudo systemctl start post2cart-runner-healthcheck.service
sudo journalctl -u post2cart-runner-healthcheck.service -n 50 --no-pager

# Restart runner manually
sudo systemctl restart actions.runner.tural-musab-post2cart-backend.devserver-post2cart-backend.service
```
