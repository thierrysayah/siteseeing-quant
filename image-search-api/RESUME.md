# Image Search — Resume Notes

## Current status
Paused. Feature is fully built but not deployed or visible to users.

## What's done
- Backend: `image-search-api/main.py` (FastAPI + YOLOE)
- Docker image already built and pushed to ECR
- Frontend: all logic in `DetectionTool.jsx` — button commented out, ready to uncomment

## To enable the button
In `src/DetectionTool.jsx`, uncomment the Image Search button block
(search for "Image Search button — hidden until backend is deployed").

## Constants to fill in (currently empty strings)
At the very top of `src/DetectionTool.jsx` lines ~13-14:
```js
const IMAGE_SEARCH_URL   = "";  // ← your deployed API URL + /search
const IMAGE_SEARCH_TOKEN = "";  // ← the API_TOKEN you set on the server
```

## ECR repo (already exists, image already pushed)
- Registry: 851725386383.dkr.ecr.eu-west-3.amazonaws.com/image-search-api
- Region: eu-west-3 (Paris)
- To rebuild and push:
  ```bash
  cd image-search-api
  aws ecr get-login-password --region eu-west-3 | docker login --username AWS --password-stdin 851725386383.dkr.ecr.eu-west-3.amazonaws.com
  docker build -t image-search-api .
  docker tag image-search-api:latest 851725386383.dkr.ecr.eu-west-3.amazonaws.com/image-search-api:latest
  docker push 851725386383.dkr.ecr.eu-west-3.amazonaws.com/image-search-api:latest
  ```

## Deployment: AWS ECS Express Mode (preferred) or Cloud Run

### Where we stopped
- Docker image built ✅
- Pushed to ECR ✅ (`docker push 851725386383.dkr.ecr.eu-west-3.amazonaws.com/image-search-api:latest`)
- Next step: create the ECS Express Mode app in AWS Console

### ECS Express Mode (next steps when resuming)
1. Go to AWS Console → ECS → "Create cluster" (use Express Mode / Fargate)
2. Create a task definition:
   - Image URI: `851725386383.dkr.ecr.eu-west-3.amazonaws.com/image-search-api:latest`
   - CPU: 2 vCPU, Memory: 8 GB
   - Port: 8000
   - Environment variables:
     - `API_TOKEN` = your secret token (you invent this)
     - `AWS_DEFAULT_REGION` = `eu-west-3`
     - `AWS_ACCESS_KEY_ID` = your AWS key
     - `AWS_SECRET_ACCESS_KEY` = your AWS secret
3. Create a service from that task definition (with a load balancer)
4. The load balancer will give you a public URL → use that as `IMAGE_SEARCH_URL`

Note: App Runner stopped accepting new customers April 30, 2026 — do not use it.

### Alternative: Google Cloud Run
Already used for the wall/zone models, simpler one-command deploy:
```bash
cd image-search-api
gcloud run deploy image-search-api \
  --source . \
  --region europe-west1 \
  --memory 8Gi \
  --cpu 2 \
  --set-env-vars API_TOKEN=your-token-here
```

## Model
- S3 bucket: `estimation-platform-image-search-model`
- Key: `yoloe-11l-seg.pt`
- Downloaded automatically by the container on first startup (cached for container lifetime)

## API contract
POST /search
Form fields: file (image), x1, y1, x2, y2 (bbox in image pixels), conf (default 0.25)
Response: `{ "detections": [{ "x1", "y1", "x2", "y2", "confidence" }] }`
Results are added as Unassigned class annotations with sourceModel: "image_search"
