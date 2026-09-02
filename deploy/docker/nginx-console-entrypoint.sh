#!/bin/sh
set -eu

TLS_DIR="${TLS_CERT_DIR:-/var/lib/nemesys/tls}"
CERT_FILE="$TLS_DIR/certificate.pem"
KEY_FILE="$TLS_DIR/private-key.pem"
TLS_HOSTNAME="${TLS_HOSTNAME:-localhost}"
TLS_SELFSIGNED_DAYS="${TLS_SELFSIGNED_DAYS:-365}"

mkdir -p "$TLS_DIR"

valid_pair() {
  [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ] &&
    openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1 &&
    openssl pkey -in "$KEY_FILE" -noout >/dev/null 2>&1 &&
    [ "$(openssl x509 -in "$CERT_FILE" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256)" = \
      "$(openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | openssl dgst -sha256)" ]
}

if ! valid_pair; then
  # Give the API sidecar time to restore a previously uploaded certificate
  # from PostgreSQL before creating the first-boot fallback.
  attempts=0
  while [ "$attempts" -lt 15 ] && ! valid_pair; do
    attempts=$((attempts + 1))
    sleep 1
  done
fi

if ! valid_pair; then
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY_FILE.tmp" -out "$CERT_FILE.tmp" \
    -days "$TLS_SELFSIGNED_DAYS" -subj "/CN=$TLS_HOSTNAME" >/dev/null 2>&1
  # Do not overwrite a certificate restored while OpenSSL was running.
  if valid_pair; then
    rm -f "$KEY_FILE.tmp" "$CERT_FILE.tmp"
  else
    mv -f "$KEY_FILE.tmp" "$KEY_FILE"
    mv -f "$CERT_FILE.tmp" "$CERT_FILE"
  fi
fi

watch_certificates() {
  while inotifywait -q -e close_write,move,create,delete "$TLS_DIR"; do
    sleep 1
    if valid_pair && nginx -t >/dev/null 2>&1; then
      nginx -s reload
    fi
  done
}

watch_certificates &
exec nginx -g 'daemon off;'