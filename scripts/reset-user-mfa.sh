#!/usr/bin/env bash
# Turn OFF two-factor authentication for one user (security audit H5).
#
# WHY THIS EXISTS: Cognito has no TOTP backup codes and no self-service reset.
# If someone loses their authenticator app and cannot restore it, this is the
# ONLY way back into their account.
#
# ⚠ THIS IS A COMPLETE MFA BYPASS. Anyone who talks you into running it has
#   defeated the user's second factor. An email saying "I lost my phone, I'm
#   Alice" proves nothing — the address can be spoofed, and the request may come
#   from the very attacker MFA was protecting against. VERIFY IDENTITY OUT OF
#   BAND FIRST: a known phone number, a video call, something tied to an account
#   they already control.
#
# Before reaching for this, check the user cannot recover unaided — most can:
#   1. Their authenticator app may sync codes (Google, Authy, 1Password);
#      installing it on a new device and signing in restores them.
#   2. They may have saved the setup key shown during enrolment, which can be
#      re-added to any authenticator app.
#
# REQUIRES the IAM action cognito-idp:AdminSetUserMFAPreference. AWS's
# AdministratorAccess-Amplify policy does NOT include it — it was added as the
# inline policy `CognitoMfaReset`. If this fails with AccessDenied, that policy
# has gone missing; see SECURITY-AUDIT.md H5.
#
# Usage:  ./scripts/reset-user-mfa.sh <username>
#   e.g.  ./scripts/reset-user-mfa.sh "someone@example.com"
#   (quote the username — addresses containing '+' break otherwise)
set -euo pipefail

POOL="${POOL:-eu-west-3_jpxbGzhTX}"
REGION="${REGION:-eu-west-3}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 <username>    (quote it if it contains '+')" >&2
  exit 1
fi
USER="$1"

echo "Pool:   $POOL ($REGION)"
echo "User:   $USER"
echo

echo "Current state:"
aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$USER" --region "$REGION" \
  --query '{Status:UserStatus,MFA:UserMFASettingList,Preferred:PreferredMfaSetting}' --output json

echo
echo "⚠  This removes the second factor from the account above."
printf 'Have you verified this person is who they claim, by some means OTHER than email? [type YES] '
read -r CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted — nothing changed."
  exit 1
fi

aws cognito-idp admin-set-user-mfa-preference \
  --user-pool-id "$POOL" --username "$USER" --region "$REGION" \
  --software-token-mfa-settings Enabled=false,PreferredMfa=false

echo
echo "State after:"
aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$USER" --region "$REGION" \
  --query '{MFA:UserMFASettingList,Preferred:PreferredMfaSetting}' --output json

echo
echo "Done. They can now sign in with their password alone."
echo "Tell them to re-enable two-factor from the account menu, and to save the"
echo "setup key this time so they can recover without us."
