import type { AppAPI } from "../../shared/types";
import type { VideoAPI } from "../../shared/video";
declare global {
  interface Window {
    video: VideoAPI;
    media: AppAPI;
  }
}
