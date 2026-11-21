(() => {
  "use strict";

  const size = 256;
  const maxFileBytes = 15 * 1024 * 1024;
  const maxAvatarBytes = 128 * 1024;
  const maxSourcePixels = 60_000_000;

  async function prepare(file) {
    if (!(file instanceof Blob) || file.size === 0) throw new Error("请选择一张图片。");
    if (file.size > maxFileBytes) throw new Error("请选择 15 MB 以内的图片。");
    if (file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name || "")) {
      throw new Error("请选择照片或 PNG 等普通图片。");
    }

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("这个设备暂时无法处理图片。请换个浏览器重试。");

    const image = new Image();
    const url = URL.createObjectURL(file);
    try {
      image.src = url;
      try {
        await image.decode();
      } catch {
        throw new Error("无法读取这张图片。请试试 JPG 或 PNG 格式。");
      }

      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height) throw new Error("无法读取这张图片。请试试 JPG 或 PNG 格式。");
      if (width * height > maxSourcePixels) throw new Error("图片分辨率太高，请先缩小图片后重试。");

      const side = Math.min(width, height);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, size, size);
      context.imageSmoothingQuality = "high";
      context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
    } finally {
      URL.revokeObjectURL(url);
    }

    const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (jpeg?.type === "image/jpeg" && jpeg.size > 0 && jpeg.size <= maxAvatarBytes) return jpeg;
    throw new Error("无法压缩这张图片。请换一张图片重试。");
  }

  window.QuizAvatarImage = { prepare };
})();
