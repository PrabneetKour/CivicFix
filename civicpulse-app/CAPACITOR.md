# From web app to installable APK

Do this **after** deploying. An installed app cannot reach `localhost` on your laptop, so
without a hosted API the APK has nothing to talk to.

## What you need

- **Android Studio** — about 4 GB, and it downloads an SDK on first run
- **JDK 17** — Android Studio installs one, use that rather than a separate copy

Budget an unhurried afternoon the first time. Every time after that is two commands.

---

## 1. Install the plugins

    cd civicpulse-app/client-ui
    npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/camera @capacitor/geolocation

`capacitor.config.json` is already in this zip — copy it into `client-ui/`.

---

## 2. Point the app at the deployed API

A native app has no dev server and no proxy, so a relative `/api` path resolves to the
app's own shell and finds nothing. `client-ui/.env.production`:

    VITE_API_URL=https://civicfix-api.onrender.com
    VITE_GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com

Then build:

    npm run build

---

## 3. Add the Android project

    npx cap add android
    npx cap sync

`android/` appears. It is a real Gradle project; commit it.

---

## 4. Permissions

`android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />

---

## 5. Let the API accept the app

**This is the step that gets missed.** A Capacitor app's requests arrive from the origin
`https://localhost`, not from your Vercel domain. Render → civicfix-api → Environment,
extend `CLIENT_ORIGIN`:

    CLIENT_ORIGIN=https://civicfix.vercel.app,https://localhost,capacitor://localhost

Without this every request from the APK fails CORS, and the app looks broken for no
visible reason.

---

## 6. Build the APK

    npx cap open android

Android Studio opens. Wait for Gradle to finish, then **Build → Build Bundle(s) / APK →
Build APK(s)**. The file lands at:

    android/app/build/outputs/apk/debug/app-debug.apk

Copy it to a phone and install it. Android will warn about an unknown source; allow it.

For a version you can share properly, **Build → Generate Signed Bundle / APK**, create a
keystore, and keep that keystore safe — it is the only thing that can ever update the app.

---

## 7. Wire up native capture — the point of all this

`src/lib/native.js` is in this zip. Copy it into `client-ui/src/lib/`.

In your report form, import it:

    import { isNative, captureEvidence } from './lib/native'

and add a capture path alongside the existing file input:

    const takePhoto = async () => {
      const shot = await captureEvidence()
      setPhoto(shot.file)
      setPos([+shot.latitude.toFixed(6), +shot.longitude.toFixed(6)])
      setExif({ hasGps: true, latitude: shot.latitude, longitude: shot.longitude, shot: shot.takenAt })
    }

Then render the native button when it is available and the file input otherwise:

    {isNative()
      ? <button className="button amber" onClick={takePhoto}>Take photo</button>
      : <label htmlFor="photo-input" className="evidence-preview">…existing file input…</label>}

### Why this fixes the geotag problem

Android strips EXIF location from any photo a browser file picker hands to a page. Nothing
running in a browser can avoid that.

Here the app owns the camera. It reads the GPS chip and takes the picture in the same
moment, and pairs them in your own code. The coordinate never travels inside a file, so
there is nothing for anyone to rewrite with ExifTool.

Once this is in, turn the rule back on and it means something:

    REQUIRE_GEOTAG=true

Note that `captureEvidence` asks for the position *before* opening the camera. If location
is refused there is no sense taking a photo that will be rejected, and the prompt is less
jarring before the shutter than after.

---

## Rebuilding after a change

    npm run build && npx cap sync && npx cap open android

Only the web assets change; the Android project stays as it is.

---

## Two things to expect

**Google sign-in needs extra work in a native shell.** The web button will not appear,
because the origin is not one Google recognises. Either use email sign-in in the app, or
add `@codetrix-studio/capacitor-google-auth`, which needs its own OAuth client of type
Android plus your app's SHA-1 fingerprint. Worth deferring until everything else works.

**The first launch is slow** while Render wakes up, if you are on the free tier. The app
will look frozen for 30 to 50 seconds. A splash screen hides some of it; paying $7 a month
removes it.
