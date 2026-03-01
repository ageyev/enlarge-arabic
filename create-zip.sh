#!/usr/bin/env bash

# (!) first change mode to 'production' in webpack config and update version in manifest and package.json

APP_NAME=$(node -p "require('./package.json').name")

# Verify version consistency between manifest.json and package.json
MANIFEST_VER=$(node -p "require('./public/manifest.json').version")
PACKAGE_VER=$(node -p "require('./package.json').version")
[[ "$MANIFEST_VER" == "$PACKAGE_VER" ]] || {
    echo "ERROR: Version mismatch — manifest.json=$MANIFEST_VER, package.json=$PACKAGE_VER";
    exit 1;
}

npm run build || { echo "Build failed"; exit 1; }

# zip from inside the dist/ directory
# (Chrome Web Store expects manifest.json at the root of the archive, not inside a subdirectory)
(cd ./dist && zip -r "../zip/${APP_NAME}.ver.${MANIFEST_VER}.zip" .)
# The subshell form (...) is cleaner — it doesn't require cd .. to restore the working directory,
# and if zip fails, you don't end up in the wrong directory.
