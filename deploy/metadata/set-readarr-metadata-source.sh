#!/usr/bin/env bash
# Points a Readarr instance at a metadata provider, printing the previous value
# so the change can be undone with the same script.
# Usage (on the Zima): bash set-readarr-metadata-source.sh <readarr-url> <config.xml path> <new source URL>
# Example: bash set-readarr-metadata-source.sh http://127.0.0.1:8787 /DATA/AppData/readarr/config/config.xml http://192.168.4.148:8788
set -euo pipefail
die() { echo "[readarr] $*" >&2; exit 1; }
[[ $# == 3 ]] || die "Usage: $0 <readarr-url> <config.xml> <metadata-source-url>"
URL=${1%/}; CONFIG=$2; SOURCE=${3%/}
[[ $SOURCE =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "Metadata source must be a plain http(s)://host[:port] URL."
KEY=$({ cat "$CONFIG" 2>/dev/null || sudo -n cat "$CONFIG"; } | grep -o '<ApiKey>[^<]*' | cut -d'>' -f2)
[[ -n $KEY ]] || die "Could not read the API key from $CONFIG."

current=$(curl -fsS --max-time 15 -H "X-Api-Key: $KEY" "$URL/api/v1/config/development") || die "Could not read Readarr's development settings."
grep -q '"metadataSource"' <<<"$current" || die "This Readarr does not expose metadataSource."
id=$(grep -o '"id": *[0-9]*' <<<"$current" | tail -1 | grep -o '[0-9]*$')
old=$(grep -o '"metadataSource": *"[^"]*"' <<<"$current" | cut -d'"' -f4)
echo "[readarr] $URL previous metadata source: ${old:-<empty: Readarr default>}"
updated=$(sed -E "s#\"metadataSource\": *\"[^\"]*\"#\"metadataSource\": \"$SOURCE\"#" <<<"$current")
result=$(curl -fsS --max-time 15 -X PUT -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  --data "$updated" "$URL/api/v1/config/development/$id") || die "Readarr rejected the update."
grep -q "\"metadataSource\": *\"$SOURCE\"" <<<"$result" || die "Readarr did not save the new source."
echo "[readarr] $URL now uses $SOURCE"
