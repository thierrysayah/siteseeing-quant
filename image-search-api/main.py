import io
import os

import boto3
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Security, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from PIL import Image
from ultralytics import YOLOE
from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

# ─── Config ───────────────────────────────────────────────────────────────────
API_TOKEN  = os.environ.get("API_TOKEN", "")
S3_BUCKET  = "estimation-platform-image-search-model"
S3_KEY     = "yoloe-11l-seg.pt"
MODEL_PATH = "/tmp/yoloe-11l-seg.pt"   # cached for the container's lifetime

app = FastAPI(title="Image Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)

security = HTTPBearer(auto_error=False)

# ─── Model (loaded once per container) ────────────────────────────────────────
_model: YOLOE | None = None


def get_model() -> YOLOE:
    global _model
    if _model is not None:
        return _model
    if not os.path.exists(MODEL_PATH):
        print(f"[startup] Downloading model from s3://{S3_BUCKET}/{S3_KEY} …")
        boto3.client("s3").download_file(S3_BUCKET, S3_KEY, MODEL_PATH)
        print("[startup] Model downloaded.")
    _model = YOLOE(MODEL_PATH)
    return _model


# ─── Auth ─────────────────────────────────────────────────────────────────────
def check_token(credentials: HTTPAuthorizationCredentials | None) -> None:
    """If API_TOKEN env var is set, require a matching Bearer token."""
    if not API_TOKEN:
        return
    if credentials is None or credentials.credentials != API_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing Bearer token")


# ─── Endpoint ─────────────────────────────────────────────────────────────────
@app.post("/search")
async def search(
    file: UploadFile = File(..., description="Full image (JPEG or PNG)"),
    x1:   float = Form(..., description="Prompt bbox x1 in image pixels"),
    y1:   float = Form(..., description="Prompt bbox y1 in image pixels"),
    x2:   float = Form(..., description="Prompt bbox x2 in image pixels"),
    y2:   float = Form(..., description="Prompt bbox y2 in image pixels"),
    conf: float = Form(0.25, description="Confidence threshold (0–1)"),
    credentials: HTTPAuthorizationCredentials | None = Security(security),
):
    check_token(credentials)

    raw    = await file.read()
    img_np = np.array(Image.open(io.BytesIO(raw)).convert("RGB"))

    model = get_model()

    results = model.predict(
        img_np,
        refer_image=img_np,
        visual_prompts={"bboxes": [[x1, y1, x2, y2]], "cls": [0]},
        predictor=YOLOEVPSegPredictor,
        conf=conf,
        verbose=False,
    )

    detections = []
    for r in results:
        if r.boxes is None:
            continue
        for box, score in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
            bx1, by1, bx2, by2 = box
            detections.append({
                "x1":         round(bx1),
                "y1":         round(by1),
                "x2":         round(bx2),
                "y2":         round(by2),
                "confidence": round(float(score), 4),
            })

    return {"detections": detections}


@app.get("/health")
async def health():
    return {"status": "ok"}
