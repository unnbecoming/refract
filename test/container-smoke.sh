#!/bin/sh
set -eu
image="${REFRACT_IMAGE:-refract:ci}"
root="$(mktemp -d)"
container=""
cleanup() { [ -z "$container" ] || docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT
mkdir -p "$root/durable" "$root/raw" "$root/secrets"
chmod 0777 "$root/durable" "$root/raw"
printf '%s' 'anthropic-container-secret' > "$root/secrets/anthropic-api-key"
printf '%s' 'openai-container-secret' > "$root/secrets/openai-api-key"
printf '%s' 'container-admin-token-long-enough' > "$root/secrets/admin-token"
chmod 0444 "$root/secrets"/*
container="$(docker run -d --read-only --user 10001:10001 --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001 \
  -v "$root/durable:/var/lib/refract" -v "$root/raw:/var/cache/refract" -v "$root/secrets:/run/secrets/refract:ro" \
  -e DATA_HOST=127.0.0.1 -e ADMIN_HOST=127.0.0.1 \
  -e ANTHROPIC_ORIGIN=https://api.anthropic.com -e OPENAI_ORIGIN=https://api.openai.com \
  -e ANTHROPIC_API_KEY_FILE=/run/secrets/refract/anthropic-api-key \
  -e OPENAI_API_KEY_FILE=/run/secrets/refract/openai-api-key -e ADMIN_TOKEN_FILE=/run/secrets/refract/admin-token "$image")"
ready=false
for i in $(seq 1 50); do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:8341/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ready=true; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || break
  sleep .2
done
if [ "$ready" != true ]; then docker logs "$container"; exit 1; fi
[ "$(docker exec "$container" id -u)" = 10001 ]
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ]
! docker exec "$container" sh -c 'touch /app/forbidden'
docker exec "$container" node dist/server/src/doctor.js >/dev/null
