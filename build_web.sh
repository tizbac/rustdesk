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

web_root=flutter/build/web
flutter_root="$(dirname "$(dirname "$(readlink -f "$(command -v flutter)")")")"
engine_version="$(cat "${flutter_root}/bin/internal/engine.version")"
# The page boots the engine with the local CanvasKit and fonts; pin the
# engine-specific revision/paths it probes for into the built index.html.
sed -i \
    -e "s/var canvasKitRevision = \"\"/var canvasKitRevision = \"${engine_version}\"/" \
    -e 's|var robotoFontPath = "roboto/v32/KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2"|var robotoFontPath = "roboto/v20/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf"|' \
    -e 's|var localCanvasKitBaseUrl = ""|var localCanvasKitBaseUrl = "canvaskit/"|' \
    "${web_root}/index.html"

# The engine fetches exactly this fallback font under "fonts/".
mkdir -p "${web_root}/fonts/roboto/v20"
if ! curl -fsSL -o "${web_root}/fonts/roboto/v20/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf" \
    "https://fonts.gstatic.com/s/roboto/v20/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf"; then
    echo "warning: could not download the Roboto fallback font" >&2
fi

tar -C "${web_root}" -czf "rustdesk-${VERSION}-web-basic.tar.gz" .