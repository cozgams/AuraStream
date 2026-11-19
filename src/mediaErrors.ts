import { isLinux } from "./api";

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return "Network error. Failed to load video, please check your network and retry.";
    case 3:
      return "Video decoding failed. Please retry.";
    case 4:
      return isLinux
        ? "System is missing H.264/AAC codecs. Please install gstreamer1.0-libav and gstreamer1.0-plugins-bad and retry."
        : "Video format is not supported.";
    default:
      return "Failed to load video. Please retry.";
  }
}
