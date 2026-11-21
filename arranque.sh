#!/bin/sh
# Arranca el guardián que mantiene despierto a Render mientras el agente trabaja y luego Wichinion.
/mantener-despierto.sh >/tmp/mantener-despierto.log 2>&1 &
exec node --max-old-space-size=256 /app/src/server.js
