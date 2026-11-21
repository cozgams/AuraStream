package com.aurastream.app

import android.app.PictureInPictureParams
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.util.Base64
import android.util.Rational
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  private var currentOutputStream: FileOutputStream? = null
  private var currentExportFile: File? = null
  var lastExportedUri: Uri? = null
  var currentWebView: WebView? = null
  var autoPipEnabled: Boolean = false
  private var wakeLock: PowerManager.WakeLock? = null
  var activeDownloadCount: Int = 0
  var isAppInForeground: Boolean = true

  @Synchronized
  fun acquireWakeLock() {
    try {
      if (wakeLock == null) {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuraStream::DownloadWakeLock")?.apply {
          setReferenceCounted(false)
        }
      }
      if (wakeLock?.isHeld != true) {
        wakeLock?.acquire(45 * 60 * 1000L) // 45 minutes max safeguard
      }
    } catch (_: Exception) {}
  }

  @Synchronized
  fun releaseWakeLock() {
    try {
      if (wakeLock?.isHeld == true) {
        wakeLock?.release()
      }
    } catch (_: Exception) {}
  }

  fun startDownloadService(title: String = "Episode", subtitle: String = "Downloading...", count: Int = 1) {
    try {
      val intent = Intent(this, AuraDownloadService::class.java).apply {
        action = AuraDownloadService.ACTION_START
        putExtra(AuraDownloadService.EXTRA_TITLE, title)
        putExtra(AuraDownloadService.EXTRA_SUBTITLE, subtitle)
        putExtra(AuraDownloadService.EXTRA_COUNT, count)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(intent)
      } else {
        startService(intent)
      }
    } catch (e: Exception) {
      e.printStackTrace()
    }
  }

  fun updateDownloadService(progress: Int, speed: String, size: String, title: String, subtitle: String, count: Int = 1) {
    try {
      val intent = Intent(this, AuraDownloadService::class.java).apply {
        action = AuraDownloadService.ACTION_UPDATE
        putExtra(AuraDownloadService.EXTRA_TITLE, title)
        putExtra(AuraDownloadService.EXTRA_SUBTITLE, subtitle)
        putExtra(AuraDownloadService.EXTRA_PROGRESS, progress)
        putExtra(AuraDownloadService.EXTRA_SPEED, speed)
        putExtra(AuraDownloadService.EXTRA_SIZE, size)
        putExtra(AuraDownloadService.EXTRA_COUNT, count)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(intent)
      } else {
        startService(intent)
      }
    } catch (_: Exception) {}
  }

  fun stopDownloadService() {
    try {
      val intent = Intent(this, AuraDownloadService::class.java).apply {
        action = AuraDownloadService.ACTION_STOP
      }
      startService(intent)
    } catch (_: Exception) {}
  }

  companion object {
    const val DOWNLOAD_CHANNEL_ID = "aurastream_downloads"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    android.util.Log.i("AuraStream", "MainActivity.onCreate called")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        setPictureInPictureParams(PictureInPictureParams.Builder().setAutoEnterEnabled(false).build())
      } catch (_: Exception) {}
    }
    createDownloadNotificationChannel()
    requestNotificationPermission()
  }

  override fun onResume() {
    super.onResume()
    isAppInForeground = true
    try {
      // Clear any ongoing download notifications while actively inside the app
      val notificationManager = androidx.core.app.NotificationManagerCompat.from(this)
      notificationManager.cancelAll()
    } catch (_: Exception) {}
    try {
      currentWebView?.onResume()
      currentWebView?.resumeTimers()
    } catch (_: Exception) {}
  }

  override fun onPause() {
    super.onPause()
    isAppInForeground = false
    try {
      // If downloads are in progress, keep WebView active and timers running in background
      if (activeDownloadCount > 0) {
        currentWebView?.onResume()
      }
      currentWebView?.resumeTimers()
    } catch (_: Exception) {}
  }

  override fun onStop() {
    super.onStop()
    isAppInForeground = false
    try {
      // Keep WebView execution alive if background downloads are running
      if (activeDownloadCount > 0) {
        currentWebView?.onResume()
        currentWebView?.resumeTimers()
      }
      android.webkit.CookieManager.getInstance().flush()
    } catch (_: Exception) {}
  }

  override fun onDestroy() {
    super.onDestroy()
    releaseWakeLock()
    stopDownloadService()
  }

  private fun createDownloadNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = android.app.NotificationChannel(
        DOWNLOAD_CHANNEL_ID,
        "Offline Downloads",
        android.app.NotificationManager.IMPORTANCE_MIN
      ).apply {
        description = "Background progress for offline episodes"
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
      }
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? android.app.NotificationManager
      manager?.createNotificationChannel(channel)
    }
  }

  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    WebView.setWebContentsDebuggingEnabled(true)
    currentWebView = webView
    webView.settings.domStorageEnabled = true
    webView.settings.databaseEnabled = true
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.addJavascriptInterface(AuraExportBridge(this), "AuraNativeExport")
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    // Auto-PiP mini popup disabled completely when user switches apps or presses home
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    runOnUiThread {
      currentWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('aurastream:pip-changed', { detail: { inPip: $isInPictureInPictureMode } }));",
        null
      )
    }
  }

  class AuraExportBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun isAvailable(): Boolean {
      return true
    }

    @JavascriptInterface
    fun isCellularNetwork(): Boolean {
      return try {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager ?: return false
        val activeNetwork = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(activeNetwork) ?: return false
        caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) &&
          !caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) &&
          !caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)
      } catch (e: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun isPictureInPictureSupported(): Boolean {
      return false
    }

    @JavascriptInterface
    fun enterPictureInPicture(): Boolean {
      return false
    }

    @JavascriptInterface
    fun enterPictureInPictureWithAspect(num: Int, den: Int): Boolean {
      return false
    }

    @JavascriptInterface
    fun setAutoPip(enabled: Boolean) {
      activity.autoPipEnabled = false
    }

    @JavascriptInterface
    fun setDownloadActiveCount(count: Int) {
      activity.runOnUiThread {
        val prev = activity.activeDownloadCount
        activity.activeDownloadCount = maxOf(0, count)
        if (activity.activeDownloadCount > 0) {
          activity.acquireWakeLock()
          if (!AuraDownloadService.isRunning) {
            activity.startDownloadService("Episode", "Downloading offline...", activity.activeDownloadCount)
          }
          activity.currentWebView?.onResume()
          activity.currentWebView?.resumeTimers()
        } else if (prev > 0) {
          activity.stopDownloadService()
          activity.releaseWakeLock()
        }
      }
    }

    @JavascriptInterface
    fun setDownloadActive(active: Boolean) {
      activity.runOnUiThread {
        val newCount = if (active) maxOf(1, activity.activeDownloadCount + 1) else maxOf(0, activity.activeDownloadCount - 1)
        setDownloadActiveCount(newCount)
      }
    }

    @JvmOverloads
    @JavascriptInterface
    fun updateDownloadNotification(id: Int, title: String, subtitle: String, progress: Int, speedFormatted: String, fileSizeFormatted: String = "") {
      activity.runOnUiThread {
        if (activity.activeDownloadCount > 0) {
          activity.updateDownloadService(progress, speedFormatted, fileSizeFormatted, title, subtitle, activity.activeDownloadCount)
        }
      }
      // Never show popups or heads-up notifications while inside the app
      if (activity.isAppInForeground) {
        return
      }
      activity.runOnUiThread {
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
              activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return@runOnUiThread
          }
          val notificationManager = androidx.core.app.NotificationManagerCompat.from(activity)
          val intent = Intent(activity, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
          }
          val pendingIntent = PendingIntent.getActivity(
            activity,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
          )
          val details = if (fileSizeFormatted.isNotEmpty() && speedFormatted.isNotEmpty()) "$fileSizeFormatted · $speedFormatted" else if (fileSizeFormatted.isNotEmpty()) fileSizeFormatted else speedFormatted
          val text = if (details.isNotEmpty()) "$subtitle · $progress% ($details)" else "$subtitle · $progress%"
          val builder = androidx.core.app.NotificationCompat.Builder(activity, DOWNLOAD_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading: $title")
            .setContentText(text)
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(text))
            .setProgress(100, progress, progress <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(pendingIntent)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
          notificationManager.notify(id, builder.build())
        } catch (e: Exception) {
          e.printStackTrace()
        }
      }
    }

    @JvmOverloads
    @JavascriptInterface
    fun showDownloadCompleteNotification(id: Int, title: String, subtitle: String, fileSizeFormatted: String = "") {
      // Never show popup or status notification while user is actively inside the app
      if (activity.isAppInForeground) {
        return
      }
      activity.runOnUiThread {
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
              activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return@runOnUiThread
          }
          val notificationManager = androidx.core.app.NotificationManagerCompat.from(activity)
          val intent = Intent(activity, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
          }
          val pendingIntent = PendingIntent.getActivity(
            activity,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
          )
          val sizeStr = if (fileSizeFormatted.isNotEmpty()) " ($fileSizeFormatted)" else ""
          val summary = "$subtitle$sizeStr saved for offline viewing · Ready to watch"
          val builder = androidx.core.app.NotificationCompat.Builder(activity, DOWNLOAD_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Download Complete: $title")
            .setContentText("$subtitle$sizeStr saved for offline viewing")
            .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText(summary))
            .setContentIntent(pendingIntent)
            .setOngoing(false)
            .setAutoCancel(true)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_DEFAULT)
          notificationManager.notify(id, builder.build())
        } catch (e: Exception) {
          e.printStackTrace()
        }
      }
    }

    @JavascriptInterface
    fun cancelDownloadNotification(id: Int) {
      activity.runOnUiThread {
        try {
          val notificationManager = androidx.core.app.NotificationManagerCompat.from(activity)
          notificationManager.cancel(id)
        } catch (e: Exception) {
          e.printStackTrace()
        }
      }
    }

    @JavascriptInterface
    fun getStorageInfo(): String {
      return try {
        val dirs = activity.getExternalFilesDirs(null)
        var hasRemovableSd = false
        var sdCardPath = ""
        var sdFreeBytes = 0L
        for (i in 1 until dirs.size) {
          val d = dirs[i]
          if (d != null && Environment.isExternalStorageRemovable(d)) {
            hasRemovableSd = true
            sdCardPath = d.absolutePath
            sdFreeBytes = d.freeSpace
            break
          }
        }
        val primaryDir = dirs.getOrNull(0) ?: activity.filesDir
        val primaryFree = primaryDir.freeSpace
        """{"hasSdCard":$hasRemovableSd,"sdCardPath":"$sdCardPath","sdFreeBytes":$sdFreeBytes,"primaryFreeBytes":$primaryFree}"""
      } catch (e: Exception) {
        """{"hasSdCard":false,"sdCardPath":"","sdFreeBytes":0,"primaryFreeBytes":0}"""
      }
    }

    @JavascriptInterface
    fun saveAppState(data: String): Boolean {
      return try {
        val file = File(activity.filesDir, "app_state_backup.json")
        val tmpFile = File(activity.filesDir, "app_state_backup.json.tmp")
        val bakFile = File(activity.filesDir, "app_state_backup.json.bak")
        tmpFile.writeText(data, Charsets.UTF_8)
        if (tmpFile.exists() && tmpFile.length() > 0) {
          if (file.exists()) {
            try { file.copyTo(bakFile, overwrite = true) } catch (_: Exception) {}
          }
          tmpFile.renameTo(file)
        }
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun loadAppState(): String {
      return try {
        val file = File(activity.filesDir, "app_state_backup.json")
        val tmpFile = File(activity.filesDir, "app_state_backup.json.tmp")
        val bakFile = File(activity.filesDir, "app_state_backup.json.bak")
        when {
          file.exists() && file.length() > 0 -> file.readText(Charsets.UTF_8)
          tmpFile.exists() && tmpFile.length() > 0 -> tmpFile.readText(Charsets.UTF_8)
          bakFile.exists() && bakFile.length() > 0 -> bakFile.readText(Charsets.UTF_8)
          else -> ""
        }
      } catch (e: Exception) {
        e.printStackTrace()
        ""
      }
    }

    @JavascriptInterface
    fun setKeepScreenOn(keepOn: Boolean) {
      activity.runOnUiThread {
        if (keepOn) {
          activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    @JavascriptInterface
    fun vibrateHaptic(type: String) {
      try {
        val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (!vibrator.hasVibrator()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val effect = when (type) {
            "heavy" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
            "medium" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK)
            else -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
          }
          vibrator.vibrate(effect)
        } else {
          val duration = when (type) {
            "heavy" -> 35L
            "medium" -> 20L
            else -> 10L
          }
          @Suppress("DEPRECATION")
          vibrator.vibrate(duration)
        }
      } catch (e: Exception) {
        e.printStackTrace()
      }
    }

    @JavascriptInterface
    fun beginExport(fileName: String): Boolean {
      return try {
        val exportsDir = File(activity.cacheDir, "exports")
        if (!exportsDir.exists()) {
          exportsDir.mkdirs()
        }
        val safeFileName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val file = File(exportsDir, safeFileName)
        if (file.exists()) {
          file.delete()
        }
        activity.currentExportFile = file
        activity.currentOutputStream = FileOutputStream(file)
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun writeChunk(base64Chunk: String): Boolean {
      return try {
        val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
        activity.currentOutputStream?.write(bytes)
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun finishExport(fileName: String, dramaTitle: String, action: String): String {
      return try {
        activity.currentOutputStream?.flush()
        activity.currentOutputStream?.close()
        activity.currentOutputStream = null

        val file = activity.currentExportFile ?: return "ERROR: No active file"

        when (action) {
          "save", "save_movies" -> {
            val safeName = if (fileName.contains(".")) fileName else "$fileName.mp4"
            val savedUri = saveToMediaStore(file, safeName, "Movies/AuraStream")
            if (savedUri != null) {
              activity.lastExportedUri = savedUri
              try { file.delete() } catch (_: Exception) {}
              "SUCCESS:Movies/AuraStream/$safeName"
            } else {
              "SAVED_LOCAL:${file.absolutePath}"
            }
          }
          "save_downloads" -> {
            val safeName = if (fileName.contains(".")) fileName else "$fileName.mp4"
            val savedUri = saveToDownloads(file, safeName)
            if (savedUri != null) {
              activity.lastExportedUri = savedUri
              try { file.delete() } catch (_: Exception) {}
              "SUCCESS:Download/AuraStream/$safeName"
            } else {
              "SAVED_LOCAL:${file.absolutePath}"
            }
          }
          "save_sdcard" -> {
            val safeName = if (fileName.contains(".")) fileName else "$fileName.mp4"
            val sdPath = saveToSdCard(file, safeName)
            if (sdPath != null) {
              try { file.delete() } catch (_: Exception) {}
              "SUCCESS:SDCard/AuraStream/$safeName"
            } else {
              val fallbackUri = saveToDownloads(file, safeName)
              if (fallbackUri != null) {
                activity.lastExportedUri = fallbackUri
                try { file.delete() } catch (_: Exception) {}
                "SUCCESS:Download/AuraStream/$safeName"
              } else {
                "SAVED_LOCAL:${file.absolutePath}"
              }
            }
          }
          "share" -> {
            activity.runOnUiThread {
              shareVideoFile(file, dramaTitle)
            }
            "SHARED:${file.name}"
          }
          "open" -> {
            activity.runOnUiThread {
              openInExternalPlayer(file)
            }
            "OPENED:${file.name}"
          }
          else -> "UNKNOWN_ACTION"
        }
      } catch (e: Exception) {
        e.printStackTrace()
        "ERROR:${e.message}"
      }
    }

    @JavascriptInterface
    fun getLastExportedUri(): String {
      return activity.lastExportedUri?.toString() ?: ""
    }

    @JavascriptInterface
    fun openInGallery(pathOrUri: String?): Boolean {
      return try {
        val targetUri = when {
          !pathOrUri.isNullOrEmpty() && (pathOrUri.startsWith("content://") || pathOrUri.startsWith("file://")) -> Uri.parse(pathOrUri)
          activity.lastExportedUri != null -> activity.lastExportedUri
          else -> null
        }

        val intent = Intent(Intent.ACTION_VIEW).apply {
          if (targetUri != null) {
            setDataAndType(targetUri, "video/mp4")
          } else {
            setDataAndType(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video/*")
          }
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val chooser = Intent.createChooser(intent, "Open in Gallery / Player")
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(chooser)
        true
      } catch (e: Exception) {
        try {
          val fallback = Intent(Intent.ACTION_VIEW).apply {
            type = "video/*"
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          val chooser = Intent.createChooser(fallback, "Open in Gallery")
          chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          activity.startActivity(chooser)
          true
        } catch (e2: Exception) {
          e2.printStackTrace()
          false
        }
      }
    }

    @JavascriptInterface
    fun exportSubtitleText(fileName: String, content: String, action: String): String {
      return try {
        val exportsDir = File(activity.cacheDir, "exports")
        if (!exportsDir.exists()) exportsDir.mkdirs()
        val safeFileName = fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_")
        val file = File(exportsDir, safeFileName)
        file.writeText(content, Charsets.UTF_8)

        val subDir = if (action == "save_downloads") "Download/AuraStream" else "Movies/AuraStream"
        val savedUri = saveToMediaStore(file, safeFileName, subDir)
        try { file.delete() } catch (_: Exception) {}
        if (savedUri != null) {
          "SUCCESS:$subDir/$safeFileName"
        } else {
          "SAVED_LOCAL:${file.absolutePath}"
        }
      } catch (e: Exception) {
        e.printStackTrace()
        "ERROR:${e.message}"
      }
    }

    private fun saveToMediaStore(sourceFile: File, displayName: String, subDir: String = "Movies/AuraStream"): Uri? {
      val resolver = activity.contentResolver
      val isDownloads = subDir.startsWith("Download")
      val isSubtitle = displayName.endsWith(".srt", ignoreCase = true) || displayName.endsWith(".vtt", ignoreCase = true)
      val mimeType = when {
        displayName.endsWith(".srt", ignoreCase = true) -> "application/x-subrip"
        displayName.endsWith(".vtt", ignoreCase = true) -> "text/vtt"
        else -> "video/mp4"
      }
      val contentValues = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.MediaColumns.RELATIVE_PATH, subDir)
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
      }

      val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        if (isDownloads || isSubtitle) {
          MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
          MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        }
      } else {
        if (isDownloads || isSubtitle) {
          @Suppress("DEPRECATION")
          val dlDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
          val auraDir = File(dlDir, "AuraStream")
          if (!auraDir.exists()) auraDir.mkdirs()
          val dest = File(auraDir, displayName)
          sourceFile.copyTo(dest, overwrite = true)
          MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf(mimeType), null)
          return Uri.fromFile(dest)
        } else {
          MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        }
      }

      val itemUri = resolver.insert(collection, contentValues) ?: return null

      var streamSuccess = false
      try {
        resolver.openOutputStream(itemUri)?.use { outStream ->
          sourceFile.inputStream().use { inStream ->
            inStream.copyTo(outStream)
          }
        }
        streamSuccess = true
      } finally {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          if (streamSuccess) {
            contentValues.clear()
            contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(itemUri, contentValues, null, null)
          } else {
            try { resolver.delete(itemUri, null, null) } catch (_: Exception) {}
          }
        }
      }

      return if (streamSuccess) itemUri else null
    }

    private fun saveToDownloads(sourceFile: File, displayName: String): Uri? {
      return saveToMediaStore(sourceFile, displayName, "Download/AuraStream")
    }

    private fun saveToSdCard(sourceFile: File, displayName: String): String? {
      val externalDirs = activity.getExternalFilesDirs(null)
      for (i in 1 until externalDirs.size) {
        val d = externalDirs[i]
        if (d != null && Environment.isExternalStorageRemovable(d)) {
          val auraDir = File(d, "AuraStream")
          if (!auraDir.exists()) auraDir.mkdirs()
          val dest = File(auraDir, displayName)
          sourceFile.copyTo(dest, overwrite = true)
          MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf("video/mp4"), null)
          return dest.absolutePath
        }
      }
      return null
    }

    private fun shareVideoFile(file: File, title: String) {
      try {
        val uri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          file
        )
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
          type = "video/mp4"
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_SUBJECT, title)
          putExtra(Intent.EXTRA_TEXT, "Watch $title on AuraStream")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(shareIntent, "Share Episode")
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(chooser)
      } catch (e: Exception) {
        e.printStackTrace()
      }
    }

    private fun openInExternalPlayer(file: File) {
      try {
        val uri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          file
        )
        val viewIntent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "video/mp4")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val chooser = Intent.createChooser(viewIntent, "Play with")
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(chooser)
      } catch (e: Exception) {
        e.printStackTrace()
      }
    }
  }
}
