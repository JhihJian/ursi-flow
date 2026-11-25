#!/bin/sh
set -eu
cd /ursi/workspace
mkdir -p hello-html
cd hello-html
occupied=$(find . -mindepth 1 -printf x -quit)
[ -z "$occupied" ] || { echo 'hello-html is not empty' >&2; exit 1; }

cat > index.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hello World</title>
</head>
<body>
  <main>
    <h1>Hello World</h1>
  </main>
</body>
</html>
HTML
sha256sum index.html
