import OpenAI from "openai";
import { env } from "../config/env.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const MIME_TO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

/**
 * Transcribe an audio file using OpenAI gpt-4o-transcribe.
 * Accepts base64-encoded audio data and returns the transcribed text.
 */
export async function transcribeAudio(
  base64: string,
  mimeType: string,
  filename: string,
): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const ext = MIME_TO_EXT[mimeType] ?? filename.split(".").pop()?.toLowerCase() ?? "wav";
  const blob = new Blob([buffer], { type: mimeType });
  const file = new File([blob], `audio.${ext}`, { type: mimeType });

  const response = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe",
    language: "cs",
  });

  return response.text;
}
