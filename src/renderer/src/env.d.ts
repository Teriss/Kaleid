import type { AppAPI } from "../../shared/types";
declare global {
  interface Window {
    media: AppAPI;
  }
}
