#!/bin/sh
set -eu
cd "$(dirname "$0")"

python -m pip install -r requirements.txt
npm --prefix web ci
npm --prefix web run build
test -s web/dist/index.html
test -s web/dist/data/summary.json
echo "HeatMatch frontend ready"

python -m api.download_speech_model
