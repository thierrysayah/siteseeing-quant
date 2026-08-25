/**
 * Bedrock vision helper — one code path via the Converse API, so the model is a
 * swappable id. Default: Claude Haiku 4.5 (EU inference profile), which is
 * current, vision-capable, good at reading title-block / scale text, and cheap.
 * Requires on-demand access via the EU inference profile (raw model ids and
 * legacy models are rejected in eu-west-3).
 */
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const Jimp = require('jimp');

const REGION = process.env.REGION || 'eu-west-3';
const MODEL = process.env.VLM_MODEL_ID || 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const client = new BedrockRuntimeClient({ region: REGION });

// Downscale so the request stays cheap and within Bedrock's image limits, while
// keeping enough resolution to read title-block / scale text.
async function downscale(buffer, maxEdge = 1568) {
  const img = await Jimp.read(buffer);
  const { width: w, height: h } = img.bitmap;
  if (Math.max(w, h) > maxEdge) img.scale(maxEdge / Math.max(w, h));
  const bytes = await img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  return { bytes, w: img.bitmap.width, h: img.bitmap.height };
}

/** Ask the VLM about an image. Returns the raw text reply. */
async function askVlmImage(imageBuffer, prompt, { maxTokens = 500, system } = {}) {
  const { bytes } = await downscale(imageBuffer);
  const res = await client.send(new ConverseCommand({
    modelId: MODEL,
    system: system ? [{ text: system }] : undefined,
    messages: [{
      role: 'user',
      content: [
        { image: { format: 'jpeg', source: { bytes } } },
        { text: prompt },
      ],
    }],
    inferenceConfig: { maxTokens, temperature: 0 },
  }));
  return (res.output?.message?.content || []).map(c => c.text || '').join('').trim();
}

/** Pull the first JSON object out of a model reply (tolerates code fences/prose). */
function extractJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

module.exports = { askVlmImage, extractJson, downscale, MODEL };
