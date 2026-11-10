// Downscale large screenshots in the browser before upload (keeps uploads under
// the 4 MB server limit and saves database space). GIFs are sent unchanged.
export async function prepareImage(file, { maxSide = 2200, maxBytes = 3.5 * 1024 * 1024 } = {}) {
  if (file.type === 'image/gif') return file;
  if (file.size <= maxBytes && file.size < 1.5 * 1024 * 1024) return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= maxBytes) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  }
  return file;
}
