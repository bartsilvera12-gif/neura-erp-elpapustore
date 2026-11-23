#!/usr/bin/env bash
# =============================================================================
# Manda un texto libre a las conversaciones que quedaron sin respuesta mientras
# la cuenta de Meta estuvo bloqueada por falta de pago.
#
# Texto libre = solo funciona DENTRO de la ventana de 24 h de cada persona.
# Por eso la lista viene ordenada por urgencia: los que están por vencer primero.
#
# Es reanudable: si lo cortás a la mitad, volvé a correrlo y saltea los que ya
# salieron (los lee del log). Nunca manda dos veces al mismo.
#
# Uso:
#   ./responder-ventana-24h.sh ids.txt
#   ./responder-ventana-24h.sh ids.txt --probar      # solo los 2 primeros
# =============================================================================
set -uo pipefail

BASE="${BASE:-https://elpapustore.neura.com.py}"
IDS_FILE="${1:?Falta el archivo con los conversation_id, uno por línea}"
MODO_PRUEBA=""
[ "${2:-}" = "--probar" ] && MODO_PRUEBA="si"

# --- El mensaje. Cambialo antes de correr. -----------------------------------
# Tiene que PEDIRLES QUE RESPONDAN: el texto libre no reanuda el bot por sí solo.
TEXTO="${TEXTO:-¡Hola! 👋 Disculpá la demora: tuvimos un problema técnico y no te llegaron nuestras respuestas. Ya está solucionado ✅

Respondé este mensaje y seguimos con tu boleta del sorteo 🚗}"

# --- Token ---------------------------------------------------------------
TOKEN="${TOKEN:-}"
if [ -z "$TOKEN" ]; then
  printf 'Pegá el access_token y Enter: '
  read -rs TOKEN
  echo
fi
[ -z "$TOKEN" ] && { echo "Sin token, no se puede."; exit 1; }

LOG="envio-$(date +%Y%m%d-%H%M%S).log"
YA_ENVIADOS=$(ls -1 envio-*.log 2>/dev/null | head -50)

ya_salio() {
  [ -z "$YA_ENVIADOS" ] && return 1
  grep -lq "^OK $1$" $YA_ENVIADOS 2>/dev/null
}

TOTAL=$(grep -c '[0-9a-f]' "$IDS_FILE")
echo "Conversaciones en la lista: $TOTAL"
echo "Log de esta corrida: $LOG"
[ -n "$MODO_PRUEBA" ] && echo ">>> MODO PRUEBA: solo las 2 primeras <<<"
echo

n=0; ok=0; err=0; skip=0
while IFS= read -r CONV; do
  CONV="$(echo "$CONV" | tr -d '[:space:]')"
  [ -z "$CONV" ] && continue
  n=$((n+1))
  [ -n "$MODO_PRUEBA" ] && [ "$n" -gt 2 ] && break

  if ya_salio "$CONV"; then
    skip=$((skip+1)); echo "SKIP $CONV  (ya salió en una corrida anterior)"; continue
  fi

  RESP=$(curl -s --max-time 30 -X POST "$BASE/api/chat/send" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "$(TEXTO="$TEXTO" CONV="$CONV" python3 -c '
import json, os
print(json.dumps({
  "conversation_id": os.environ["CONV"],
  "message": os.environ["TEXTO"],
  "sender_type": "human",
}))')")

  if echo "$RESP" | grep -q '"ok":true'; then
    ok=$((ok+1)); echo "OK $CONV" | tee -a "$LOG" >/dev/null
    printf '[%d/%d] OK   %s\n' "$n" "$TOTAL" "$CONV"
  else
    err=$((err+1)); echo "ERR $CONV $RESP" >> "$LOG"
    printf '[%d/%d] ERR  %s  -> %s\n' "$n" "$TOTAL" "$CONV" "$(echo "$RESP" | head -c 160)"
  fi

  sleep 0.5
done < "$IDS_FILE"

echo
echo "Enviados OK: $ok   Errores: $err   Salteados: $skip"
echo "Detalle en $LOG"
