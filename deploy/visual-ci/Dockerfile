# Environment only: current checkout/dependencies/build are supplied at run time.
FROM node:22.22.2-bookworm-slim@sha256:868499d55378719bffa87b0ed1f099591823c029b543043c09c2483468e93201 AS node22
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
# Keep the renderer base's npm11.6.2; the accepted environment changed only node.
COPY --from=node22 /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core=20201225-2 fonts-noto-mono=20201225-2 && rm -rf /var/lib/apt/lists/*
COPY renderer.mjs renderer.expected.json /renderer/
RUN node /renderer/renderer.mjs /renderer/renderer.expected.json
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
WORKDIR /build
