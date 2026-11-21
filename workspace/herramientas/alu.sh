#!/usr/bin/env bash
# ALU simulada de Wichi (ver alu.pl). Uso: alu.sh <suma|resta|multiplicacion|division> <a> <b> [<c> ...] [--dec N] [--sin-ceros] [--detalle]
exec perl "$(dirname "$0")/alu.pl" "$@"
