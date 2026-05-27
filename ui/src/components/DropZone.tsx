import { useCallback, useEffect, useState } from "react";
import "./DropZone.css";

interface Props {
  onFile: (file: File) => void;
}

export default function DropZone({ onFile }: Props) {
  const [dragging, setDragging] = useState(false);

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onEnter = useCallback((e: DragEvent) => {
    stop(e);
    // Only show the overlay when a file (not a text drag, not internal element) is over the page.
    if (e.dataTransfer?.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const onLeave = useCallback((e: DragEvent) => {
    stop(e);
    // The drag-leave event fires for every child element. Only hide
    // when the cursor leaves the window itself.
    if (e.relatedTarget == null || (e as DragEvent).clientX <= 0 || (e as DragEvent).clientY <= 0) {
      setDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      stop(e);
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const videos = files.filter((f) => /\.(mp4|mov|m4v|webm)$/i.test(f.name));
      if (videos.length === 0) {
        alert("Expected MP4 / MOV / M4V / WebM files.");
        return;
      }
      // Kick off each import — they run as parallel daemon threads on the
      // backend, so batch-dropping 5 Looms starts 5 simultaneous pipelines.
      videos.forEach((f) => onFile(f));
    },
    [onFile],
  );

  useEffect(() => {
    document.addEventListener("dragover", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [onEnter, onLeave, onDrop]);

  if (!dragging) return null;
  return (
    <div className="dropzone-overlay" aria-hidden>
      <div className="dropzone-card">
        <div className="dropzone-icon">↓</div>
        <div className="dropzone-text">Drop the Loom to import</div>
        <div className="dropzone-sub">MP4 · MOV · M4V · WebM</div>
      </div>
    </div>
  );
}
