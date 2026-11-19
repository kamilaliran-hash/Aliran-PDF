ALIRAN PDF FOR ANDROID
======================
Same editor as the Windows app (the ../web folder), packed into an Android app.
Works offline. Android 10 or newer.

BUILD THE APK - choose one:

A) On your PC (Windows)
   1. Install Android Studio (free): https://developer.android.com/studio
      Open it once and finish the setup wizard (it downloads the Android SDK).
   2. Double-click android\build-apk.bat
   3. The APK appears as AliranPDF.apk next to the android folder.
   (Or open the "android" folder in Android Studio and press Build > Build APK.)

B) In the cloud with GitHub (nothing to install)
   Every push to main builds the APK: Actions tab > Build > latest run >
   download the "AliranPDF-android" artifact. See SIGNING
The APK is signed with app\aliran-release.jks (password: aliranpdf).
Keep this file safe and NEVER commit it to GitHub (the repository is public).
Updates must be signed with the same key to install over the old version.
- On your PC: put aliran-release.jks in the app folder, then run build-apk.bat.
- On GitHub: add the keystore as the ALIRAN_KEYSTORE_BASE64 repository secret
  (Settings > Secrets and variables > Actions). Without it, GitHub builds a
  debug-signed APK that cannot update the release-signed app.
