#!/bin/bash

set -e

# Run from the repo root
mkdir -p ./build-api/combined;
rm ./build-api/*.json ./build-api/combined/*.json || true 2> /dev/null

for i in $(ls packages/*/api-extractor*.json); do
    node ./packages/typescript-reference-doc-generator/bin/api-extractor.js \
        run -c $i --local --verbose;
done;

# Unique modules that the API docs were sourced from
for module in $(find . -type f -maxdepth 3 -name 'api-extractor*.json' -exec dirname "{}" \; | xargs basename | sort -u | uniq | grep -v '\.'); do
    node ./packages/typescript-reference-doc-generator/bin/merge-api-models.js \
        ./build-api/$module.*json > build-api/combined/$module.api.json;
done;
