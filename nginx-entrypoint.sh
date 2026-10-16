#!/bin/sh
apk add --no-cache apache2-utils
htpasswd -bc /etc/nginx/.htpasswd "$RDP_USER" "$RDP_PASSWORD"
