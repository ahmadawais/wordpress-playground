#!/bin/bash

# Run from the repo root

bash ./scripts/build-api-model.sh
node ./build-scripts/generate-reference-docs.js -i ./build-api/combined -o ./docs/api
node ./scripts/build-readme-md-files.js
