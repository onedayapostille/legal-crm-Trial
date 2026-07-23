#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

readonly ADMIN_SCRIPTS="/home/developer/alghazzawi-server-admin/scripts"
readonly EXPECTED_BRANCH="main"
readonly SHA_PATTERN='^[0-9a-f]{40}$'

refuse() {
  printf 'Refused by Actions deployment guard.\n' >&2
  exit 64
}

read -r -a request <<<"${SSH_ORIGINAL_COMMAND:-}"
case "${request[0]:-}" in
  deploy)
    [[ "${#request[@]}" -eq 5 ]] || refuse
    [[ "${request[1]}" == "--branch" && "${request[2]}" == "$EXPECTED_BRANCH" ]] || refuse
    [[ "${request[3]}" == "--commit" && "${request[4]}" =~ $SHA_PATTERN ]] || refuse
    exec "$ADMIN_SCRIPTS/deploy-crm.sh" "${request[4]}"
    ;;
  rollback)
    [[ "${#request[@]}" -eq 3 ]] || refuse
    [[ "${request[1]}" == "--failed-commit" && "${request[2]}" =~ $SHA_PATTERN ]] || refuse
    exec "$ADMIN_SCRIPTS/rollback-crm.sh"
    ;;
  *)
    refuse
    ;;
esac
