#!/bin/sh
# Stamp CSS/JS links in index.html with a new version so browsers fetch fresh files after a site-code change.
cd "$(dirname "$0")/.." && V=$(date -u +%Y%m%d%H%M) && sed -i.bak -E "s#assets/(style.css|app.js)(\?v=[0-9]+)?#assets/\1?v=$V#g" index.html && rm -f index.html.bak && echo "assets stamped v=$V"
