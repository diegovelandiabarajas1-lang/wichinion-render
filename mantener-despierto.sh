#!/bin/sh
# Mantiene despierto el servidor gratuito de Render MIENTRAS un agente trabaja.
# Render apaga el servicio tras 15 min sin tráfico entrante. Si el agente está ocupado y nadie envía
# mensajes, no llega tráfico: este guardián lo detecta (/api/session/active) y se llama a sí mismo
# por la dirección pública, que cuenta como tráfico entrante. Cuando nada trabaja, deja que Render duerma.
PUERTO="${MOTOR_PORT:-10000}"
USUARIO="${MOTOR_USER:-opencode}"
CLAVE="${OPENCODE_SERVER_PASSWORD:-${MOTOR_PASSWORD:-}}"
PUBLICA="${RENDER_EXTERNAL_URL:-}"
CADA="${WICHI_PING_CADA:-120}"        # segundos entre comprobaciones
GRACIA="${WICHI_GRACIA:-600}"         # segundos extra despierto tras terminar el último trabajo
[ -n "$PUBLICA" ] || exit 0           # fuera de Render no hace falta
ultimo=0
sleep 30                              # deja arrancar Wichinion
while true; do
  activo=$(curl -s -m 20 -u "$USUARIO:$CLAVE" "http://127.0.0.1:$PUERTO/api/session/active" 2>/dev/null)
  ahora=$(date +%s)
  case "$activo" in *'"running"'*) ultimo=$ahora ;; esac
  if [ $((ahora - ultimo)) -le "$GRACIA" ] && [ "$ultimo" -ne 0 ]; then
    curl -s -m 30 -o /dev/null -u "$USUARIO:$CLAVE" "$PUBLICA/api/info" 2>/dev/null
  fi
  sleep "$CADA"
done
