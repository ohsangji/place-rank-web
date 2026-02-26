#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "📦 패키지 설치 중..."
  npm install
fi
echo "🚀 서버 시작..."
node server.js
