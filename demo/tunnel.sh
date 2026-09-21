#!/bin/sh
# Terowongan SSH ke dasbor VPS yang menyambung ulang sendiri kalau putus.
#   ./tunnel.sh            -> lpcopy  (port 20150)
#   ./tunnel.sh 20180      -> port lain, mis. lpcopy3
PORT=${1:-20150}
while true; do
  ssh -N -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -L "$PORT:127.0.0.1:$PORT" singapore
  sleep 1
done
