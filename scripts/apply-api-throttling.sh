#!/usr/bin/env bash
# Re-apply API Gateway throttling (security audit C3).
#
# WHY THIS EXISTS: `amplify push` regenerates the API stack and wipes stage
# method settings, so these throttles must be re-applied after every push.
# Run it as part of your deploy routine:  amplify push && ./scripts/apply-api-throttling.sh
#
# These are PER-STAGE totals, not per-user — they stop a runaway client from
# draining Lambda concurrency and running up the bill, but they do not enforce
# fairness between users. Per-user quotas are audit finding C2.
set -euo pipefail

API_ID="${API_ID:-ed5boc93x2}"
STAGE="${STAGE:-dev}"
REGION="${REGION:-eu-west-3}"

# Routes are declared with ANY, but API Gateway method settings only accept
# concrete verbs — so each route is set for every verb it can receive.
VERBS=(GET POST PUT DELETE)

# resource-path(with / as ~1)  rate  burst
ROUTES=(
  "~1infer                10 50"   # model inference — expensive, 3rd-party rate limits
  "~1agent                10 20"   # agent run + 1.5s status poll per active run
  "~1session~1heartbeat   20 50"
  "~1session~1claim        5 20"
  "~1user~1profile        10 20"
  "~1org~1grant-access     5 10"
  "~1projects             10 20"   # project control-file writes; autosave is ~1 call/10s/user
)

echo "Applying throttles to $API_ID/$STAGE in $REGION"

# Stage-wide backstop, covers every route including any added later.
aws apigateway update-stage --rest-api-id "$API_ID" --stage-name "$STAGE" --region "$REGION" \
  --no-cli-pager --output text --query stageName \
  --patch-operations '[{"op":"replace","path":"/*/*/throttling/rateLimit","value":"25"},
                       {"op":"replace","path":"/*/*/throttling/burstLimit","value":"50"}]' >/dev/null
echo "  */*  25/50  (backstop)"

for row in "${ROUTES[@]}"; do
  read -r path rate burst <<<"$row"
  for verb in "${VERBS[@]}"; do
    aws apigateway update-stage --rest-api-id "$API_ID" --stage-name "$STAGE" --region "$REGION" \
      --no-cli-pager --output text --query stageName \
      --patch-operations "[{\"op\":\"replace\",\"path\":\"/$path/$verb/throttling/rateLimit\",\"value\":\"$rate\"},
                           {\"op\":\"replace\",\"path\":\"/$path/$verb/throttling/burstLimit\",\"value\":\"$burst\"}]" >/dev/null
  done
  echo "  $path  $rate/$burst"
done

echo "Done. Verify: aws apigateway get-stage --rest-api-id $API_ID --stage-name $STAGE --region $REGION --query methodSettings"
