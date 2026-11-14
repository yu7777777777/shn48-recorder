set -eu
printf '%s\n' '--- runtime ---'
docker inspect -f 'image={{.Config.Image}} imageId={{.Image}} status={{.State.Status}} restart={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' shn48-recorder
printf '%s\n' '--- health ---'
curl -fsS --max-time 15 http://127.0.0.1:3000/api/public/health
printf '\n%s\n' '--- runtime version ---'
docker exec shn48-recorder cat /app/VERSION
printf '%s\n' '--- runtime hashes ---'
docker exec shn48-recorder sh -c 'cd /app && find server client/dist -type f ! -path "*/node_modules/*" ! -path "*/__pycache__/*" ! -name "*.pyc" -exec sha256sum {} +; sha256sum VERSION'
