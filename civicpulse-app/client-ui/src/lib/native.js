/**
 * Native capture, when the app is running inside Capacitor.
 *
 * This is the fix for the geotag problem. A browser file picker on Android hands the page
 * a copy of the photo with the EXIF location removed — a privacy decision in Chrome that
 * no website can opt out of. So in a web build we fall back to a file input and take the
 * device's own GPS reading separately.
 *
 * Inside a native shell the app owns the camera. It takes the picture and reads the GPS
 * chip in the same moment, and pairs them itself. The coordinate never passes through a
 * file, so there is nothing for anyone to edit — which is a stronger guarantee than EXIF
 * ever offered.
 */

export const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

/**
 * Capture a photo and the position it was taken at.
 * @returns {Promise<{file: File, latitude: number, longitude: number, accuracy: number, takenAt: string}>}
 */
export async function captureEvidence() {
  if (!isNative()) throw new Error('Native capture is only available in the installed app.');

  const [{ Camera, CameraResultType, CameraSource }, { Geolocation }] = await Promise.all([
    import('@capacitor/camera'),
    import('@capacitor/geolocation')
  ]);

  /* Ask for the position first. If location is refused there is no point taking a photo
     we would have to reject, and the permission prompt is less jarring before the camera
     opens than after. */
  const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });

  const photo = await Camera.getPhoto({
    quality: 82,
    allowEditing: false,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,     // the camera itself, never the gallery
    saveToGallery: true,
    correctOrientation: true
  });

  const blob = await (await fetch(photo.webPath)).blob();
  const file = new File([blob], `evidence.${photo.format || 'jpg'}`, { type: blob.type || 'image/jpeg' });

  return {
    file,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    takenAt: new Date().toISOString()
  };
}

/** A short clip. Capacitor's camera plugin does stills only, so this uses the file input. */
export async function pickVideo() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.capture = 'environment';
    input.onchange = () => resolve(input.files?.[0] || null);
    input.click();
  });
}

/** Live position, native or web — the plugin falls back to the browser API on its own. */
export async function currentPosition() {
  if (isNative()) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No location support'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}
