#!/usr/bin/env bash
cd /Users/loh/data/FileSystem/mimocode2api
API_KEY=$(cat .api-key | tr -d '\n')
export API_KEY
export MIMOCODE_SERVER_URL=http://127.0.0.1:10001
export MIMOCODE_PROXY_PORT=10002
export MIMOCODE_PROXY_MANAGE_BACKEND=false
export DISABLE_TOOLS=false
export MIMOCODE_PROXY_DEBUG=true
exec node index.js
