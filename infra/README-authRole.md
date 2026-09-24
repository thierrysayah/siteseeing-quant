# Cognito authenticated role — S3 scoping (security audit C5)

`infra/authRole-s3-policy.json` is the inline policy on
`amplify-estimationplatform-dev-20748-authRole`, the role **every signed-in user
assumes**. It is committed here because the bucket is an *imported* Amplify
resource, so this IAM lives outside the Amplify stack and is not recreated by
`amplify push`.

## Why it matters

The browser talks to S3 **directly** with real AWS credentials from the identity
pool — storage calls do not pass through a Lambda. So this policy, not the client
code, is the only tenant boundary. `private/` is an Amplify naming convention,
not a security control.

## What was wrong (fixed 2026-09-24)

1. `AmazonS3FullAccess` was **attached** to the role: `s3:*` on `*`. Any signed-in
   user could read, overwrite or delete every object in all 16 buckets in the
   account — including the ML model weights, the Amplify deployment buckets and
   unrelated projects — plus `s3:DeleteBucket` and `s3:PutBucketPolicy`.
2. The inline policy granted the whole `estimation-platform-user-data` bucket,
   so every tenant could read every other tenant's drawings.

## How it is scoped now

`${cognito-identity.amazonaws.com:sub}` is the **identity-pool identity id**, but
the S3 paths use the **user-pool sub** — so the usual Amplify condition does not
work here. Instead the identity pool maps claims to **principal tags**
(Cognito "attributes for access control"):

    sub    -> aws:PrincipalTag/sub
    orgId  <- custom:orgId  -> aws:PrincipalTag/orgId

and the policy scopes to `private/users/${aws:PrincipalTag/sub}/*` and
`private/organisations/org-${aws:PrincipalTag/orgId}/*`. This also required
`sts:TagSession` in the role's trust policy.

## Re-apply

    aws iam put-role-policy --role-name amplify-estimationplatform-dev-20748-authRole \
      --policy-name EstimationS3PrivateAccess \
      --policy-document file://infra/authRole-s3-policy.json

    aws cognito-identity set-principal-tag-attribute-map \
      --identity-pool-id eu-west-3:0fa85c34-17a2-42ce-ada5-f7c2cf1d9086 \
      --identity-provider-name cognito-idp.eu-west-3.amazonaws.com/eu-west-3_jpxbGzhTX \
      --no-use-defaults --principal-tags sub=sub,orgId=custom:orgId --region eu-west-3

**Never re-attach `AmazonS3FullAccess` (or any `s3:*` managed policy) to this role.**

## Known gap

Org access is granted at org granularity: any member of an org can reach every
project under that org's prefix, whereas `ProjectGrants` intends per-project
sharing. Closing that needs Lambda-mediated reads (presigned URLs) rather than
direct S3 IAM. Tracked as the remainder of C5.
