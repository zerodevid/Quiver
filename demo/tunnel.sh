#!/bin/sh
# Terowongan SSH ke dasbor VPS yang menyambung ulang sendiri kalau putus.
while true; do
  ssh -N -o ServerAliveInterval=10 -o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -L 20150:127.0.0.1:20150 singapore
  sleep 1
done
