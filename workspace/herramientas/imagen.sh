#!/bin/bash
# Crea una imagen con NVIDIA NIM (FLUX) y la deja en /workspace/entregas para que la app la muestre.
# Uso: imagen.sh "descripción de la imagen" nombre.png [ancho] [alto]
set -u
PROMPT="${1:?Falta la descripción de la imagen}"
OUT="${2:-imagen.png}"
ANCHO="${3:-1024}"
ALTO="${4:-1024}"
CLAVE="${NVIDIA_API_KEY:-}"
[ -n "$CLAVE" ] || CLAVE=$(cat /root/.wichi/nvidia.key 2>/dev/null)
if [ -z "$CLAVE" ]; then
  echo "ERROR: el servidor no tiene la clave de NVIDIA. Pide a la persona que la guarde en Ajustes de la app (Mi clave de NVIDIA)."
  exit 2
fi
MODELO="${WICHI_IMAGEN_MODELO:-black-forest-labs/flux.1-schnell}"
DIR=/workspace/entregas
mkdir -p "$DIR"
OUT=$(basename "$OUT")
case "$OUT" in *.png|*.jpg|*.jpeg|*.webp) ;; *) OUT="$OUT.png" ;; esac
# Escapa barras y comillas para el JSON y quita saltos de línea
ESC=$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r' '  ')
RESP=$(curl -s -m 150 -X POST "https://ai.api.nvidia.com/v1/genai/$MODELO" \
  -H "Authorization: Bearer $CLAVE" -H "Accept: application/json" -H "Content-Type: application/json" \
  -d "{\"prompt\":\"$ESC\",\"width\":$ANCHO,\"height\":$ALTO,\"seed\":0,\"steps\":4}")
B64=$(printf '%s' "$RESP" | grep -o '"base64" *: *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//')
if [ -z "$B64" ]; then
  echo "ERROR al generar la imagen (modelo $MODELO): $(printf '%s' "$RESP" | head -c 300)"
  exit 3
fi
printf '%s' "$B64" | base64 -d > "$DIR/$OUT"
echo "Imagen lista: $DIR/$OUT"
