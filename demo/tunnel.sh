#!/bin/sh
# SSH tunnel to the VPS dashboard that reconnects by itself when dropped.
#   ./tunnel.sh            -> lpcopy  (port 20150)
#   ./tunnel.sh 20180      -> another port, e.g. lpcopy3
PORT=${1:-20150}
while true; do
  ssh -N -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -L "$PORT:127.0.0.1:$PORT" singapore
  sleep 1
done
