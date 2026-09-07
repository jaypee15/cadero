export interface CameraScanner {
  start(onFrame: (imageData: ImageData) => void): Promise<void>;
  stop(): void;
}

export function createCameraScanner(video: HTMLVideoElement): CameraScanner {
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  return {
    async start(onFrame) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      timer = setInterval(() => {
        if (!ctx || video.videoWidth === 0) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        onFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
      }, 250);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
    },
  };
}
