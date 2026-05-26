import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { api } from "../api";
import type { Cut } from "../types";
import "./VideoPlayer.css";

export interface VideoPlayerHandle {
  togglePlay: () => void;
  seekBy: (delta: number) => void;
  seekTo: (t: number) => void;
  getTime: () => number;
  isPaused: () => boolean;
}

interface Props {
  projectId: string;
  cuts: Cut[]; // active cuts only — used to skip past dead space during preview
  currentTime: number;
  onTimeChange: (t: number) => void;
  showOutput: boolean;
  renderedAt: number;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(
  { projectId, cuts, currentTime, onTimeChange, showOutput, renderedAt },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      togglePlay: () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
      },
      seekBy: (delta) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, v.currentTime + delta);
      },
      seekTo: (t) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = t;
      },
      getTime: () => videoRef.current?.currentTime ?? 0,
      isPaused: () => videoRef.current?.paused ?? true,
    }),
    [],
  );

  // Live preview: when the source-video playhead enters a cut, jump past it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || showOutput) return;
    const onTime = () => {
      const t = v.currentTime;
      onTimeChange(t);
      const hit = cuts.find((c) => t >= c.start && t < c.end);
      if (hit) v.currentTime = hit.end + 0.001;
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [cuts, onTimeChange, showOutput]);

  // External seek → sync into the video element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - currentTime) > 0.25) {
      v.currentTime = currentTime;
    }
  }, [currentTime]);

  const url = showOutput
    ? `${api.outputUrl(projectId)}?t=${renderedAt}`
    : api.sourceUrl(projectId);

  return (
    <div className="stage">
      <div className="video-wrap">
        <video
          ref={videoRef}
          src={url}
          controls
          preload="metadata"
          playsInline
        />
      </div>
    </div>
  );
});

export default VideoPlayer;
