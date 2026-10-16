#!/bin/bash
echo "Starting tunnels... keep this script running"
ssh -tt -o StrictHostKeyChecking=no -R 80:localhost:8080 nokey@localhost.run &
LOCAL_RUN_PID=$!
ssh -p 443 -o StrictHostKeyChecking=no -R0:localhost:3389 tcp@a.pinggy.io &
PINGGY_PID=$!

trap "kill $LOCAL_RUN_PID $PINGGY_PID" EXIT
wait
