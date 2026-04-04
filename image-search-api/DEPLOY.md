# Deploying Image Search API to AWS ECS Fargate + ALB

## Architecture
Browser → ALB (HTTPS) → ECS Fargate Task (FastAPI on port 8000)

---

## 1. Build & Push Docker image to ECR

```bash
REGION=us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO=image-search-api

# Create ECR repo (once)
aws ecr create-repository --repository-name $REPO --region $REGION

# Build & push
aws ecr get-login-password --region $REGION | \
  docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com

docker build -t $REPO .
docker tag $REPO:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest
```

---

## 2. ECS Task Definition (key settings)

- **CPU**: 2048 (2 vCPU) — YOLOE inference is CPU-heavy
- **Memory**: 8192 MB
- **Container port**: 8000
- **Environment variables**:
  - `API_TOKEN` — Bearer token the frontend sends (set to any secret string)
  - `AWS_DEFAULT_REGION` — e.g. `us-east-1`
- **Task IAM Role**: must have `s3:GetObject` on `estimation-platform-image-search-model/*`

---

## 3. ECS Service + ALB

1. Create an ECS cluster (Fargate)
2. Create an ALB with HTTPS listener (port 443, ACM certificate)
3. Target group: port 8000, health check path `/health`
4. Create ECS Service pointing to the task definition, registered with the target group

---

## 4. Update the frontend

Once deployed, set these two constants in `src/DetectionTool.jsx`:

```js
const IMAGE_SEARCH_URL   = "https://your-alb-domain.us-east-1.elb.amazonaws.com/search";
const IMAGE_SEARCH_TOKEN = "your-api-token";
```

---

## 5. Model update (no redeploy needed)

To swap the model, just upload a new `yoloe-11l-seg.pt` to the S3 bucket and restart the ECS tasks:

```bash
aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
```
