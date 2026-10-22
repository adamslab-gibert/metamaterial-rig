#!/bin/sh
# Give the website's CSS/JS links a new ?v= number so browsers load the new files at once
# (run after changing anything in docs/assets/, then commit).
V=$(date +%Y%m%d%H%M)
for f in "$(dirname "$0")"/../docs/*.html; do
  sed -i -E "s#(href|src)=\"assets/([a-z0-9_.-]+\.(css|js))(\?v=[0-9]+)?\"#\1=\"assets/\2?v=$V\"#g" "$f"
done
echo "asset version $V"
