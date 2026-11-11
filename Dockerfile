# Dockerfile — trial server ONLY (makeLesson) on Hugging Face Spaces (Docker SDK).
#
# Runs ONLY the "paste a YouTube link -> shadowing lesson" function, reusing
# the exact pipeline in functions/src/pipeline.js (buildLessonFree) that the
# Firebase function would have run. NOT the whole app, NOT Firebase — the
# Firebase code in functions/index.js is never loaded here.
#
# Why Docker on HF Spaces: Render free now demands a card for new accounts
# (2026-11-11, even for the $0 plan) and Firebase deploys demand billing on
# project donghung-3208d. HF Spaces free CPU (2 vCPU / 16 GB RAM, no card)
# is the trial host that is certain not to ask for a card.
#
# HF Spaces runs this container and sets PORT=7860; server.js reads
# process.env.PORT (default 3000), so no code change is needed.
# Node 20 matches the "engines" field of both package.json files.
#
# Build context is the sorakanji-backend/ repo root. .dockerignore keeps
# node_modules, tests, tools and docs out of the context; the image installs
# dependencies fresh in the two layers below.

FROM node:20

WORKDIR /app

# 1. functions/ dependencies — the pipeline needs kuromoji (furigana) and
#    @google-cloud/translate (paid path, imported by pipeline.js even though
#    the trial uses the free translator). Node resolves them from
#    ../functions/node_modules relative to functions/src/pipeline.js, so
#    they must be installed in functions/, not in trial-server/.
#    --legacy-peer-deps: firebase-functions v5 declares peer admin ^11||^12
#    while the project uses admin 13 (same as render.yaml).
COPY functions/package.json functions/package-lock.json ./functions/
RUN cd functions && npm install --legacy-peer-deps

# 2. trial-server dependencies (express only).
COPY trial-server/package.json trial-server/package-lock.json ./trial-server/
RUN cd trial-server && npm install

# 3. Application code only — no node_modules, no tests, no tools,
#    no Firebase entry point (functions/index.js is not copied).
COPY functions/src/ ./functions/src/
COPY trial-server/server.js ./trial-server/server.js

# Hugging Face Spaces serves the container on this port.
EXPOSE 7860

CMD ["node", "trial-server/server.js"]
