export const ACTION_IDS = {
  IMG_JPG: "img_jpg",
  IMG_PNG: "img_png",
  IMG_WEBP: "img_webp",
  MD_HTML: "md_html",
  VID_GIF: "vid_gif",
  VID_COMPRESS: "vid_compress",
  VID_MP3: "vid_mp3",
  VID_WAV: "vid_wav",
  VID_TRANSCRIBE: "vid_transcribe",
  VID_TRANSCRIBE_SRT: "vid_transcribe_srt",
  VID_TRANSCRIBE_VTT: "vid_transcribe_vtt",
  AUD_MP3: "aud_mp3",
  AUD_WAV: "aud_wav",
  AUD_TRANSCRIBE: "aud_transcribe",
  AUD_TRANSCRIBE_SRT: "aud_transcribe_srt",
  AUD_TRANSCRIBE_VTT: "aud_transcribe_vtt",
} as const;

export type ActionId = typeof ACTION_IDS[keyof typeof ACTION_IDS];

export const ALL_ACTION_IDS = Object.values(ACTION_IDS) as ActionId[];
const actionIdSet = new Set<string>(ALL_ACTION_IDS);

export function isActionId(value: string): value is ActionId {
  return actionIdSet.has(value);
}

export const IMAGE_ACTION_IDS = [
  ACTION_IDS.IMG_JPG,
  ACTION_IDS.IMG_PNG,
  ACTION_IDS.IMG_WEBP,
] as const;
export type ImageActionId = typeof IMAGE_ACTION_IDS[number];
export type ImageOutputFormat = "jpg" | "png" | "webp";

export const ACTION_LABELS: Record<ActionId, string> = {
  [ACTION_IDS.IMG_JPG]: "转换为 JPG",
  [ACTION_IDS.IMG_PNG]: "转换为 PNG",
  [ACTION_IDS.IMG_WEBP]: "转换为 WebP",
  [ACTION_IDS.MD_HTML]: "导出 HTML",
  [ACTION_IDS.VID_GIF]: "转换为 GIF",
  [ACTION_IDS.VID_COMPRESS]: "压缩视频",
  [ACTION_IDS.VID_MP3]: "提取音频 (MP3)",
  [ACTION_IDS.VID_WAV]: "提取音频 (WAV)",
  [ACTION_IDS.VID_TRANSCRIBE]: "转写文字",
  [ACTION_IDS.VID_TRANSCRIBE_SRT]: "转写字幕 (SRT)",
  [ACTION_IDS.VID_TRANSCRIBE_VTT]: "转写字幕 (VTT)",
  [ACTION_IDS.AUD_MP3]: "转换为 MP3",
  [ACTION_IDS.AUD_WAV]: "转换为 WAV",
  [ACTION_IDS.AUD_TRANSCRIBE]: "转写文字",
  [ACTION_IDS.AUD_TRANSCRIBE_SRT]: "转写字幕 (SRT)",
  [ACTION_IDS.AUD_TRANSCRIBE_VTT]: "转写字幕 (VTT)",
};

export const REALTIME_ACTION_IDS = new Set<ActionId>([
  ACTION_IDS.VID_GIF,
  ACTION_IDS.VID_COMPRESS,
  ACTION_IDS.VID_MP3,
  ACTION_IDS.VID_WAV,
  ACTION_IDS.AUD_MP3,
  ACTION_IDS.AUD_WAV,
  ACTION_IDS.VID_TRANSCRIBE,
  ACTION_IDS.AUD_TRANSCRIBE,
  ACTION_IDS.VID_TRANSCRIBE_SRT,
  ACTION_IDS.AUD_TRANSCRIBE_SRT,
  ACTION_IDS.VID_TRANSCRIBE_VTT,
  ACTION_IDS.AUD_TRANSCRIBE_VTT,
]);

export function isImageActionId(actionId: string): actionId is ImageActionId {
  return IMAGE_ACTION_IDS.includes(actionId as ImageActionId);
}

export function imageOutputFormatFromActionId(
  actionId: ImageActionId,
): ImageOutputFormat {
  switch (actionId) {
    case ACTION_IDS.IMG_JPG:
      return "jpg";
    case ACTION_IDS.IMG_PNG:
      return "png";
    case ACTION_IDS.IMG_WEBP:
      return "webp";
  }
}

export function imageActionIdFromOutputFormat(
  format: ImageOutputFormat,
): ImageActionId {
  switch (format) {
    case "jpg":
      return ACTION_IDS.IMG_JPG;
    case "png":
      return ACTION_IDS.IMG_PNG;
    case "webp":
      return ACTION_IDS.IMG_WEBP;
  }
}
