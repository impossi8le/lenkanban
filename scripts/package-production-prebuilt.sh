#!/usr/bin/env bash
set -euo pipefail
SOURCE_COMMIT=${SOURCE_COMMIT:?exact source commit required}
APP_ORIGIN=https://taskboard.lenremontn8n.ru
SOURCE_DIR="$(realpath "${1:?source checkout required}")"
OUTPUT_DIR="${2:?new artifact directory required}"
CONTROL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$SOURCE_COMMIT"
git -C "$SOURCE_DIR" diff --quiet HEAD --
test -z "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=all)"
test ! -e "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(realpath "$OUTPUT_DIR")"
# No build secret mounts/arguments, registry login, application start, migrations or DB checks.
unset DATABASE_URL TEST_DATABASE_URL E2E_DATABASE_URL PRODUCTION_DATABASE_URL
unset NEXTAUTH_SECRET AUTH_SECRET TELEMETRY_SESSION_SECRET SENTRY_AUTH_TOKEN
APP_IMAGE="lenkanban-app:$SOURCE_COMMIT"
SOCKET_IMAGE="lenkanban-socket:$SOURCE_COMMIT"
cd "$SOURCE_DIR"
COMMON=(--platform linux/amd64 --file Dockerfile --load --pull
  --build-arg "NEXT_PUBLIC_APP_URL=$APP_ORIGIN"
  --build-arg 'NEXT_PUBLIC_SOCKET_URL='
  --build-arg "GIT_COMMIT=$SOURCE_COMMIT"
  --label "org.opencontainers.image.revision=$SOURCE_COMMIT"
  --label 'org.opencontainers.image.source-role=production-prebuilt')
docker buildx build "${COMMON[@]}" --target runner --tag "$APP_IMAGE" .
docker buildx build "${COMMON[@]}" --target socket --tag "$SOCKET_IMAGE" .
for role in app socket; do
  image="lenkanban-$role:$SOURCE_COMMIT"
  docker image inspect --format '{"id":"{{.Id}}","os":"{{.Os}}","architecture":"{{.Architecture}}","revision":"{{index .Config.Labels "org.opencontainers.image.revision"}}"}' "$image" > "$OUTPUT_DIR/$role-image.json"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --env "IMAGE_ROLE=$role" --entrypoint node \
    --mount "type=bind,source=$CONTROL_DIR/verify-prebuilt-runtime.cjs,target=/verify-prebuilt-runtime.cjs,readonly" \
    "$image" /verify-prebuilt-runtime.cjs > "$OUTPUT_DIR/$role-runtime.json"
  docker image save "$image" | gzip -1n > "$OUTPUT_DIR/$role-linux-amd64.tar.gz"
done
export SOURCE_COMMIT APP_ORIGIN OUTPUT_DIR
python3 - <<'PY'
import hashlib, json, os, pathlib, re
out = pathlib.Path(os.environ['OUTPUT_DIR'])
source = os.environ['SOURCE_COMMIT']
images = {}
for role in ('app', 'socket'):
    image = json.loads((out / (role + '-image.json')).read_text())
    runtime = json.loads((out / (role + '-runtime.json')).read_text())
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image['id'])
    assert (image['os'], image['architecture'], image['revision']) == ('linux', 'amd64', source)
    assert runtime['role'] == role and not runtime['databaseConnected'] and not runtime['serverStarted']
    archive = out / (role + '-linux-amd64.tar.gz')
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    images[role] = {'tag': 'lenkanban-' + role + ':' + source, 'image': image, 'runtime': runtime,
                    'archive': archive.name, 'archiveBytes': archive.stat().st_size, 'archiveSha256': digest}
metadata = {'sourceCommit': source, 'workflowCommit': os.environ.get('GITHUB_SHA'),
            'githubRunId': os.environ.get('GITHUB_RUN_ID'), 'githubRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
            'platform': 'linux/amd64', 'publicAppUrl': os.environ['APP_ORIGIN'], 'publicSocketUrl': '',
            'dockerfileSha256': hashlib.sha256(pathlib.Path('Dockerfile').read_bytes()).hexdigest(),
            'packageLockSha256': hashlib.sha256(pathlib.Path('package-lock.json').read_bytes()).hexdigest(),
            'images': images, 'noProductionSecretsOrDatabase': True, 'deployed': False}
(out / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
PY
(
  cd "$OUTPUT_DIR"
  sha256sum app-linux-amd64.tar.gz socket-linux-amd64.tar.gz app-image.json socket-image.json app-runtime.json socket-runtime.json manifest.json > SHA256SUMS
  sha256sum --check SHA256SUMS
)
printf 'Built and verified app+socket archives from %s; no deployment performed.\n' "$SOURCE_COMMIT"
