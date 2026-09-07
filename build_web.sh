#!/usr/bin/env bash
# Builds the RustDesk web client (Flutter + web JS) and packs the release tarball.
set -ue

cd "$(dirname "$0")"

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"

(
    cd flutter/web/js
    yarn install
    yarn build
)

(
    cd flutter
    flutter build web --release
)

tar -C flutter/build/web -czf "rustdesk-${VERSION}-web-basic.tar.gz" .