#!/bin/zsh
cd "$(dirname "$0")"
exec node --no-warnings src/index.js "$@"
