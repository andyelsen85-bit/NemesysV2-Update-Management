#!/bin/sh
set -eu

# This is intentionally a dependency-free regression check.  It can run in a
# checkout without an Nginx binary and protects the log format from ever
# reintroducing query strings into container stdout.
config_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config="$config_dir/nginx-main.conf"

format=$(sed -n '/^[[:space:]]*log_format main /,/;/p' "$config")
if [ -z "$format" ]; then
    echo "nginx-main.conf does not define log_format main" >&2
    exit 1
fi
if ! grep -Eq '^[[:space:]]*access_log[[:space:]]+/dev/stdout[[:space:]]+main;' "$config"; then
    echo "nginx-main.conf does not send the sanitized format to stdout" >&2
    exit 1
fi

if printf '%s\n' "$format" |
    grep -Eq '\$(request|request_uri|args|query_string|is_args|http_referer)([^A-Za-z0-9_]|$)'; then
    echo "unsafe query-bearing Nginx log variable found" >&2
    exit 1
fi

for token in '$request_method' '$uri' '$status' '$request_time' '$upstream_status' '$upstream_response_time'; do
    case "$format" in
        *"$token"*) ;;
        *)
            echo "required Nginx log variable is missing: $token" >&2
            exit 1
            ;;
    esac
done

echo "Nginx access logging is path-only and includes status/timing metadata."
