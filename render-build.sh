#!/bin/sh
set -eu
cd "$(dirname "$0")"

python -m pip install -r requirements.txt
npm --prefix web ci
npm --prefix web run build
test -s web/dist/index.html
test -s web/dist/data/summary.json
echo "HeatMatch frontend ready"

HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_DISABLE_XET=1 \
    python -c "from faster_whisper.utils import download_model; download_model('tiny.en', output_dir='.models/tiny.en')"
