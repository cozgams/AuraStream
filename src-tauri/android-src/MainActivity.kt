package com.aurastream.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.atomic.AtomicLong

class MainActivity : TauriActivity() {
  private val exportLock = Any()
  private var currentOutputStream: FileOutputStream? = null
  private var currentExportFile: File? = null
  var lastExportedUri: Uri? = null
  var currentWebView: WebView? = null
  var autoPipEnabled: Boolean = false
  private var wakeLock: PowerManager.WakeLock? = null
  var activeDownloadCount: Int = 0
  @Volatile
  var isAppInForeground: Boolean = true

  private val stateLock = Any()
  private val stateDiskLock = Any()
  private var pendingAppState: String? = null
  private var stateVersion: Long = 0L
  private var persistedStateVersion: Long = 0L
  private var stateHandlerThread: HandlerThread? = null
  private var stateHandler: Handler? = null
  private val stateFlushRunnable = Runnable { writePendingAppStateToDisk() }

  private fun ensureStateHandler(): Handler? {
    synchronized(stateLock) {
      if (stateHandler == null) {
        val thread = HandlerThread("AuraStateBackup")
        thread.start()
        stateHandlerThread = thread
        stateHandler = Handler(thread.looper)
      }
      return stateHandler
    }
  }

  private fun scheduleAppStateFlush() {
    val handler = ensureStateHandler() ?: return
    handler.removeCallbacks(stateFlushRunnable)
    handler.postDelayed(stateFlushRunnable, 600L)
  }

  private fun flushAppStateAsync() {
    val handler = synchronized(stateLock) { stateHandler } ?: return
    handler.removeCallbacks(stateFlushRunnable)
    handler.post(stateFlushRunnable)
  }

  private fun flushAppStateSync() {
    val handler = synchronized(stateLock) { stateHandler }
    handler?.removeCallbacks(stateFlushRunnable)
    writePendingAppStateToDisk()
  }

  private fun quitStateHandlerThread() {
    val thread = synchronized(stateLock) {
      stateHandler?.removeCallbacks(stateFlushRunnable)
      stateHandler = null
      val t = stateHandlerThread
      stateHandlerThread = null
      t
    }
    try {
      thread?.quitSafely()
    } catch (_: Exception) {}
  }

  private fun writePendingAppStateToDisk() {
    val snapshot: Pair<String, Long>? = synchronized(stateLock) {
      val data = pendingAppState
      if (data != null && stateVersion > persistedStateVersion) {
        data to stateVersion
      } else {
        null
      }
    }
    if (snapshot == null) return
    val (data, version) = snapshot
    synchronized(stateDiskLock) {
      try {
        val file = File(filesDir, "app_state_backup.json")
        val tmpFile = File(filesDir, "app_state_backup.json.tmp")
        val bakFile = File(filesDir, "app_state_backup.json.bak")
        tmpFile.writeText(data, Charsets.UTF_8)
        if (tmpFile.exists() && tmpFile.length() > 0) {
          if (file.exists()) {
            try { file.copyTo(bakFile, overwrite = true) } catch (_: Exception) {}
          }
          if (!tmpFile.renameTo(file)) {
            tmpFile.copyTo(file, overwrite = true)
            tmpFile.delete()
          }
        }
        synchronized(stateLock) {
          if (version > persistedStateVersion) {
            persistedStateVersion = version
          }
        }
      } catch (e: Exception) {
        e.printStackTrace()
      }
    }
  }

  private fun cleanupExportsDir(olderThanMs: Long, excludeCanonicalPath: String? = null) {
    try {
      val exportsDir = File(cacheDir, "exports")
      if (!exportsDir.exists() || !exportsDir.isDirectory) return
      val now = System.currentTimeMillis()
      val activePath = synchronized(exportLock) { currentExportFile?.absolutePath }
      exportsDir.listFiles()?.forEach { f ->
        val canon = try { f.canonicalPath } catch (_: Exception) { f.absolutePath }
        if (f.isFile && f.absolutePath != activePath && canon != excludeCanonicalPath) {
          if (olderThanMs <= 0L || (now - f.lastModified()) > olderThanMs) {
            try { f.delete() } catch (_: Exception) {}
          }
        }
      }
    } catch (_: Exception) {}
  }

  private fun closeCurrentExportStream() {
    synchronized(exportLock) {
      try {
        currentOutputStream?.close()
      } catch (_: Exception) {}
      currentOutputStream = null
    }
  }

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
    serviceStartRequested = true
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
      serviceStartRequested = false
      android.util.Log.w("AuraStream", "startDownloadService rejected: ${e.message}")
    }
  }

  fun updateDownloadService(id: Int, progress: Int, speed: String, size: String, title: String, subtitle: String, count: Int = 1) {
    val clamped = progress.coerceIn(0, 100)
    AuraDownloadService.upsertDownload(id, title, subtitle, clamped, speed, size)
    if (AuraDownloadService.isRunning) {
      val svc = AuraDownloadService.instance
      if (svc != null) {
        svc.refreshNotification(count)
      } else {
        try {
          val intent = Intent(this, AuraDownloadService::class.java).apply {
            action = AuraDownloadService.ACTION_UPDATE
            putExtra(AuraDownloadService.EXTRA_ID, id)
            putExtra(AuraDownloadService.EXTRA_TITLE, title)
            putExtra(AuraDownloadService.EXTRA_SUBTITLE, subtitle)
            putExtra(AuraDownloadService.EXTRA_PROGRESS, clamped)
            putExtra(AuraDownloadService.EXTRA_SPEED, speed)
            putExtra(AuraDownloadService.EXTRA_SIZE, size)
            putExtra(AuraDownloadService.EXTRA_COUNT, count)
          }
          startService(intent)
        } catch (_: Exception) {}
      }
    } else if (isAppInForeground && !serviceStartRequested && count > 0) {
      startDownloadService(title, subtitle, count)
    }
  }

  fun stopDownloadService() {
    serviceStartRequested = false
    try {
      stopService(Intent(this, AuraDownloadService::class.java))
    } catch (_: Exception) {}
  }

  companion object {
    const val DOWNLOAD_CHANNEL_ID = "aurastream_downloads"
    @Volatile
    var isForegroundGlobal: Boolean = true
    @Volatile
    var serviceStartRequested: Boolean = false
    @Volatile
    private var activeActivityRef: WeakReference<MainActivity>? = null

    @JvmStatic
    fun releaseGlobalWakeLock() {
      activeActivityRef?.get()?.releaseWakeLock()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    android.util.Log.i("AuraStream", "MainActivity.onCreate called")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    activeActivityRef = WeakReference(this)
    isForegroundGlobal = true
    cleanupExportsDir(0L)
    createDownloadNotificationChannel()
    requestNotificationPermission()
  }

  override fun onResume() {
    super.onResume()
    isAppInForeground = true
    isForegroundGlobal = true
    AuraDownloadService.clearCompletedSummary()
    try {
      androidx.core.app.NotificationManagerCompat.from(this).cancel(AuraDownloadService.COMPLETE_NOTIFICATION_ID)
    } catch (_: Exception) {}
    try {
      currentWebView?.onResume()
      currentWebView?.resumeTimers()
      currentWebView?.post {
        currentWebView?.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('aurastream:app-resumed'));",
          null
        )
      }
    } catch (_: Exception) {}
  }

  override fun onPause() {
    super.onPause()
    isAppInForeground = false
    isForegroundGlobal = false
    try {
      // If downloads are in progress, keep WebView active and timers running in background
      if (activeDownloadCount > 0) {
        currentWebView?.onResume()
        currentWebView?.resumeTimers()
      }
    } catch (_: Exception) {}
    flushAppStateAsync()
  }

  override fun onStop() {
    super.onStop()
    isAppInForeground = false
    isForegroundGlobal = false
    try {
      // Keep WebView execution alive if background downloads are running
      if (activeDownloadCount > 0) {
        currentWebView?.onResume()
        currentWebView?.resumeTimers()
      }
      android.webkit.CookieManager.getInstance().flush()
    } catch (_: Exception) {}
    flushAppStateAsync()
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    runOnUiThread {
      currentWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('aurastream:permissions-changed'));",
        null
      )
    }
  }

  override fun onDestroy() {
    super.onDestroy()
    releaseWakeLock()
    if (activeActivityRef?.get() === this) {
      activeActivityRef = null
    }
    closeCurrentExportStream()
    flushAppStateSync()
    quitStateHandlerThread()
    if (!isChangingConfigurations && activeDownloadCount <= 0 && !AuraDownloadService.hasActiveDiskDownloads(this)) {
      stopDownloadService()
    }
  }

  private fun createDownloadNotificationChannel() {
    AuraDownloadService.ensureSilentChannels(this)
  }

  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        getSharedPreferences("aurastream_perms", Context.MODE_PRIVATE)
          .edit()
          .putBoolean("asked_notif", true)
          .apply()
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    currentWebView = webView
    webView.settings.domStorageEnabled = true
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
      } catch (_: Exception) {
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

    @Suppress("UNUSED_PARAMETER")
    @JavascriptInterface
    fun enterPictureInPictureWithAspect(num: Int, den: Int): Boolean {
      return false
    }

    @Suppress("UNUSED_PARAMETER")
    @JavascriptInterface
    fun setAutoPip(enabled: Boolean) {
      activity.autoPipEnabled = false
    }

    @JavascriptInterface
    fun setOrientation(landscape: Boolean) {
      activity.runOnUiThread {
        activity.requestedOrientation = if (landscape) {
          ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
          ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
      }
    }

    @JavascriptInterface
    fun setDownloadActiveCount(count: Int) {
      activity.runOnUiThread {
        val prev = activity.activeDownloadCount
        activity.activeDownloadCount = maxOf(0, count)
        if (activity.activeDownloadCount > 0) {
          activity.acquireWakeLock()
          if (!AuraDownloadService.isRunning && !MainActivity.serviceStartRequested) {
            activity.startDownloadService("Episode", "Downloading offline...", activity.activeDownloadCount)
          } else {
            AuraDownloadService.instance?.refreshNotification(activity.activeDownloadCount)
          }
          activity.currentWebView?.onResume()
          activity.currentWebView?.resumeTimers()
        } else if ((prev > 0 || AuraDownloadService.isRunning || MainActivity.serviceStartRequested) && !AuraDownloadService.hasActiveDiskDownloads(activity)) {
          AuraDownloadService.clearDownloads()
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
        val clampedProgress = progress.coerceIn(0, 100)
        AuraDownloadService.upsertDownload(id, title, subtitle, clampedProgress, speedFormatted, fileSizeFormatted)
        if (activity.activeDownloadCount > 0) {
          activity.updateDownloadService(id, clampedProgress, speedFormatted, fileSizeFormatted, title, subtitle, activity.activeDownloadCount)
        } else {
          activity.activeDownloadCount = 1
          activity.startDownloadService(title, subtitle, 1)
          activity.updateDownloadService(id, clampedProgress, speedFormatted, fileSizeFormatted, title, subtitle, 1)
        }
      }
    }

    private fun safeNotifId(id: Int): Int {
      return if (id == AuraDownloadService.NOTIFICATION_ID) id + 1_000_000 else id
    }

    @JvmOverloads
    @JavascriptInterface
    fun showDownloadCompleteNotification(id: Int, title: String, subtitle: String, fileSizeFormatted: String = "") {
      activity.runOnUiThread {
        try {
          AuraDownloadService.removeDownload(id)
          if (AuraDownloadService.isRunning && activity.activeDownloadCount > 0) {
            AuraDownloadService.instance?.refreshNotification(activity.activeDownloadCount)
          }
          val notifId = safeNotifId(id)
          androidx.core.app.NotificationManagerCompat.from(activity).cancel(notifId)
          // Never show completion notification while user is actively inside the app
          if (activity.isAppInForeground) {
            return@runOnUiThread
          }
          AuraDownloadService.showSilentCompletionBanner(activity, title, subtitle, fileSizeFormatted)
        } catch (e: Exception) {
          e.printStackTrace()
        }
      }
    }

    @JavascriptInterface
    fun cancelDownloadNotification(id: Int) {
      activity.runOnUiThread {
        try {
          AuraDownloadService.removeDownload(id)
          if (AuraDownloadService.isRunning && activity.activeDownloadCount > 0) {
            AuraDownloadService.instance?.refreshNotification(activity.activeDownloadCount)
          }
          val notificationManager = androidx.core.app.NotificationManagerCompat.from(activity)
          notificationManager.cancel(safeNotifId(id))
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
        var sdTotalBytes = 0L
        for (i in 1 until dirs.size) {
          val d = dirs[i]
          if (d != null && Environment.isExternalStorageRemovable(d)) {
            hasRemovableSd = true
            sdCardPath = d.absolutePath
            sdFreeBytes = d.freeSpace
            sdTotalBytes = d.totalSpace
            break
          }
        }
        val primaryDir = dirs.getOrNull(0) ?: activity.filesDir
        val primaryFree = primaryDir.freeSpace
        val primaryTotal = primaryDir.totalSpace
        JSONObject().apply {
          put("hasSdCard", hasRemovableSd)
          put("sdCardPath", sdCardPath)
          put("sdFreeBytes", sdFreeBytes)
          put("sdTotalBytes", sdTotalBytes)
          put("primaryFreeBytes", primaryFree)
          put("primaryTotalBytes", primaryTotal)
        }.toString()
      } catch (_: Exception) {
        JSONObject().apply {
          put("hasSdCard", false)
          put("sdCardPath", "")
          put("sdFreeBytes", 0L)
          put("sdTotalBytes", 0L)
          put("primaryFreeBytes", 0L)
          put("primaryTotalBytes", 0L)
        }.toString()
      }
    }

    @JavascriptInterface
    fun saveAppState(data: String): Boolean {
      return try {
        synchronized(activity.stateLock) {
          activity.pendingAppState = data
          activity.stateVersion += 1L
        }
        activity.scheduleAppStateFlush()
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun loadAppState(): String {
      val cached = synchronized(activity.stateLock) { activity.pendingAppState }
      if (cached != null) return cached
      return synchronized(activity.stateDiskLock) {
        try {
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
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? android.os.VibratorManager)?.defaultVibrator
        } else {
          @Suppress("DEPRECATION")
          activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          val effect = when (type) {
            "heavy" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
            "medium" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK)
            "light", "selection" -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
            else -> VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
          }
          vibrator.vibrate(effect)
        } else {
          val duration = when (type) {
            "heavy" -> 35L
            "medium" -> 20L
            "light", "selection" -> 6L
            else -> 12L
          }
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE))
          } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(duration)
          }
        }
      } catch (e: Exception) {
        e.printStackTrace()
      }
    }

    private fun mimeTypeForFileName(displayName: String): String {
      return when {
        displayName.endsWith(".srt", ignoreCase = true) -> "application/x-subrip"
        displayName.endsWith(".vtt", ignoreCase = true) -> "text/vtt"
        displayName.endsWith(".ass", ignoreCase = true) ||
          displayName.endsWith(".ssa", ignoreCase = true) ||
          displayName.endsWith(".txt", ignoreCase = true) -> "text/plain"
        displayName.endsWith(".ts", ignoreCase = true) -> "video/mp2t"
        else -> "video/mp4"
      }
    }

    private fun sanitizeExportFileName(raw: String, fallbackPrefix: String, fallbackExt: String): String {
      val base = File(raw).name
      val sanitized = base.replace("[^a-zA-Z0-9._-]".toRegex(), "_").trim('_', '.')
      if (sanitized.isEmpty() || sanitized == "." || sanitized == ".." || sanitized.contains("..")) {
        return "${fallbackPrefix}_${System.currentTimeMillis()}.$fallbackExt"
      }
      return sanitized
    }

    @JavascriptInterface
    fun beginExport(fileName: String): Boolean {
      return synchronized(activity.exportLock) {
        try {
          try {
            activity.currentOutputStream?.close()
          } catch (_: Exception) {}
          activity.currentOutputStream = null
          activity.currentExportFile = null

          activity.cleanupExportsDir(30 * 60 * 1000L)

          val exportsDir = File(activity.cacheDir, "exports").canonicalFile
          if (!exportsDir.exists()) {
            exportsDir.mkdirs()
          }
          val safeFileName = sanitizeExportFileName(fileName, "export", "mp4")
          val file = File(exportsDir, safeFileName).canonicalFile
          if (!file.path.startsWith(exportsDir.path + File.separator)) {
            return@synchronized false
          }
          if (file.exists()) {
            file.delete()
          }
          activity.currentExportFile = file
          activity.currentOutputStream = FileOutputStream(file)
          true
        } catch (e: Exception) {
          e.printStackTrace()
          activity.currentOutputStream = null
          activity.currentExportFile = null
          false
        }
      }
    }

    @JavascriptInterface
    fun writeChunk(base64Chunk: String): Boolean {
      return synchronized(activity.exportLock) {
        try {
          val stream = activity.currentOutputStream ?: return@synchronized false
          val bytes = Base64.decode(base64Chunk, Base64.DEFAULT)
          stream.write(bytes)
          true
        } catch (e: Exception) {
          e.printStackTrace()
          false
        }
      }
    }

    private fun handleExportedFile(file: File, fileName: String, dramaTitle: String, action: String): String {
      return when (action) {
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
          val sdFile = saveToSdCard(file, safeName)
          if (sdFile != null) {
            try {
              activity.lastExportedUri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                sdFile
              )
            } catch (_: Exception) {
              if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                activity.lastExportedUri = Uri.fromFile(sdFile)
              }
            }
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
          try {
            activity.lastExportedUri = FileProvider.getUriForFile(
              activity,
              "${activity.packageName}.fileprovider",
              file
            )
          } catch (_: Exception) {}
          activity.runOnUiThread {
            shareVideoFile(file, dramaTitle)
          }
          "SHARED:${file.name}"
        }
        "open" -> {
          try {
            activity.lastExportedUri = FileProvider.getUriForFile(
              activity,
              "${activity.packageName}.fileprovider",
              file
            )
          } catch (_: Exception) {}
          activity.runOnUiThread {
            openInExternalPlayer(file)
          }
          "OPENED:${file.name}"
        }
        else -> "UNKNOWN_ACTION"
      }
    }

    @JavascriptInterface
    fun finishExport(fileName: String, dramaTitle: String, action: String): String {
      return synchronized(activity.exportLock) {
        try {
          val stream = activity.currentOutputStream
          try {
            stream?.flush()
          } finally {
            try {
              stream?.close()
            } catch (_: Exception) {}
            activity.currentOutputStream = null
          }

          val file = activity.currentExportFile ?: return@synchronized "ERROR: No active file"
          activity.currentExportFile = null
          handleExportedFile(file, fileName, dramaTitle, action)
        } catch (e: Exception) {
          e.printStackTrace()
          "ERROR:${e.message}"
        }
      }
    }

    @JavascriptInterface
    fun exportLocalFile(sourcePath: String, fileName: String, dramaTitle: String, action: String): String {
      return synchronized(activity.exportLock) {
        try {
          val exportsDir = File(activity.cacheDir, "exports").canonicalFile
          val file = File(sourcePath).canonicalFile
          if (!file.path.startsWith(exportsDir.path + File.separator) || !file.exists() || !file.isFile) {
            return@synchronized "ERROR:Prepared export file not found"
          }
          activity.cleanupExportsDir(30 * 60 * 1000L, file.path)
          handleExportedFile(file, fileName, dramaTitle, action)
        } catch (e: Exception) {
          e.printStackTrace()
          "ERROR:${e.message}"
        }
      }
    }

    @JavascriptInterface
    fun getLastExportedUri(): String {
      return activity.lastExportedUri?.toString() ?: ""
    }

    @JavascriptInterface
    fun openInGallery(pathOrUri: String?): Boolean {
      return try {
        val exportsDir = File(activity.cacheDir, "exports").canonicalFile
        val targetUri: Uri? = when {
          !pathOrUri.isNullOrEmpty() && pathOrUri.startsWith("content://") -> Uri.parse(pathOrUri)
          !pathOrUri.isNullOrEmpty() && pathOrUri.startsWith("file://") && Build.VERSION.SDK_INT < Build.VERSION_CODES.N -> Uri.parse(pathOrUri)
          !pathOrUri.isNullOrEmpty() && !pathOrUri.startsWith("file://") -> {
            val candidate = File(pathOrUri).canonicalFile
            if (candidate.path.startsWith(exportsDir.path + File.separator) && candidate.exists() && candidate.isFile) {
              FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                candidate
              )
            } else {
              activity.lastExportedUri
            }
          }
          activity.lastExportedUri != null -> activity.lastExportedUri
          else -> null
        }

        val resolvedMime = if (targetUri != null) {
          activity.contentResolver.getType(targetUri)
            ?: mimeTypeForFileName(pathOrUri ?: targetUri.lastPathSegment ?: "video.mp4")
        } else {
          "video/*"
        }

        val intent = Intent(Intent.ACTION_VIEW).apply {
          if (targetUri != null) {
            setDataAndType(targetUri, resolvedMime)
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
      } catch (_: Exception) {
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
        activity.cleanupExportsDir(30 * 60 * 1000L)
        val exportsDir = File(activity.cacheDir, "exports").canonicalFile
        if (!exportsDir.exists()) exportsDir.mkdirs()
        val safeFileName = sanitizeExportFileName(fileName, "subtitle", "srt")
        val file = File(exportsDir, safeFileName).canonicalFile
        if (!file.path.startsWith(exportsDir.path + File.separator)) {
          return "ERROR:Invalid subtitle filename"
        }
        file.writeText(content, Charsets.UTF_8)

        val subDir = if (action == "save_downloads") "Download/AuraStream" else "Movies/AuraStream"
        val savedUri = saveToMediaStore(file, safeFileName, subDir)
        if (savedUri != null) {
          activity.lastExportedUri = savedUri
          try { file.delete() } catch (_: Exception) {}
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
      val isSubtitle = displayName.endsWith(".srt", ignoreCase = true) ||
        displayName.endsWith(".vtt", ignoreCase = true) ||
        displayName.endsWith(".ass", ignoreCase = true) ||
        displayName.endsWith(".ssa", ignoreCase = true) ||
        displayName.endsWith(".txt", ignoreCase = true)
      val resolvedSubDir = if (isDownloads || isSubtitle) {
        if (subDir.startsWith("Download")) subDir else "Download/AuraStream"
      } else {
        subDir
      }
      val mimeType = mimeTypeForFileName(displayName)
      val contentValues = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          put(MediaStore.MediaColumns.RELATIVE_PATH, resolvedSubDir)
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
          MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf(mimeType)) { _, uri ->
            if (uri != null) activity.lastExportedUri = uri
          }
          return try {
            FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", dest)
          } catch (_: Exception) {
            Uri.fromFile(dest)
          }
        } else {
          contentValues.put(MediaStore.MediaColumns.DATA, File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "AuraStream/$displayName").apply { parentFile?.mkdirs() }.absolutePath)
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
          streamSuccess = true
        }
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

    private fun saveToSdCard(sourceFile: File, displayName: String): File? {
      val externalDirs = activity.getExternalFilesDirs(null)
      val mimeType = mimeTypeForFileName(displayName)
      for (i in 1 until externalDirs.size) {
        val d = externalDirs[i]
        if (d != null && Environment.isExternalStorageRemovable(d)) {
          val auraDir = File(d, "AuraStream")
          if (!auraDir.exists()) auraDir.mkdirs()
          val dest = File(auraDir, displayName)
          sourceFile.copyTo(dest, overwrite = true)
          MediaScannerConnection.scanFile(activity, arrayOf(dest.absolutePath), arrayOf(mimeType)) { _, scannedUri ->
            if (scannedUri != null) activity.lastExportedUri = scannedUri
          }
          return dest
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
          type = mimeTypeForFileName(file.name)
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
          setDataAndType(uri, mimeTypeForFileName(file.name))
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

    @Volatile
    private var otaCancelled: Boolean = false

    @Volatile
    private var otaActiveConnection: HttpURLConnection? = null

    private val otaDownloadToken = AtomicLong(0L)

    private fun dispatchOtaEvent(payload: JSONObject) {
      val jsPayload = payload.toString()
      activity.runOnUiThread {
        activity.currentWebView?.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('aurastream:ota-progress',{detail:$jsPayload}));",
          null
        )
      }
    }

    private fun sanitizeOtaApkName(fileName: String): String {
      return fileName.replace("[^a-zA-Z0-9._-]".toRegex(), "_").trim('_').let {
        when {
          it.isEmpty() -> "AuraStream_update.apk"
          it.endsWith(".apk", ignoreCase = true) -> it
          else -> "$it.apk"
        }
      }
    }

    private fun packageVersionCodeCompat(info: android.content.pm.PackageInfo): Long {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode
      } else {
        @Suppress("DEPRECATION")
        info.versionCode.toLong()
      }
    }

    private fun installedVersionCodeCompat(): Long {
      return try {
        val currentInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          activity.packageManager.getPackageInfo(
            activity.packageName,
            PackageManager.PackageInfoFlags.of(0)
          )
        } else {
          @Suppress("DEPRECATION")
          activity.packageManager.getPackageInfo(activity.packageName, 0)
        }
        packageVersionCodeCompat(currentInfo)
      } catch (_: Exception) {
        0L
      }
    }

    private fun validateOtaApkFile(file: File, expectedSize: Long = 0L): String? {
      if (!file.exists() || !file.isFile || file.length() < 1_000_000L) {
        return "Downloaded APK appears incomplete (${file.length()} bytes)"
      }
      if (expectedSize > 0L && file.length() != expectedSize) {
        return "Incomplete update download (${file.length()} / $expectedSize bytes)"
      }
      val header = ByteArray(4)
      val headerRead = try {
        file.inputStream().use { it.read(header) }
      } catch (_: Exception) {
        0
      }
      val validZip = headerRead == 4 &&
        header[0] == 0x50.toByte() &&
        header[1] == 0x4B.toByte() &&
        header[2] == 0x03.toByte() &&
        header[3] == 0x04.toByte()
      if (!validZip) {
        return "Downloaded file is not a valid APK package"
      }
      val pkgInfo = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          activity.packageManager.getPackageArchiveInfo(
            file.absolutePath,
            PackageManager.PackageInfoFlags.of(0)
          )
        } else {
          @Suppress("DEPRECATION")
          activity.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        }
      } catch (_: Exception) {
        null
      }
      if (pkgInfo == null || pkgInfo.packageName != activity.packageName) {
        return "Downloaded file does not match ${activity.packageName}"
      }
      val apkVer = packageVersionCodeCompat(pkgInfo)
      val currentVer = installedVersionCodeCompat()
      if (currentVer > 0L && apkVer < currentVer) {
        return "Update package version ($apkVer) is older than installed ($currentVer)"
      }
      val installedCerts = signingCertDigestsCompat(null)
      val archiveCerts = signingCertDigestsCompat(file.absolutePath)
      if (installedCerts.isNotEmpty() && archiveCerts.isNotEmpty() && installedCerts.intersect(archiveCerts).isEmpty()) {
        return "Update package signing certificate does not match installed app"
      }
      return null
    }

    private fun signingCertDigestsCompat(archivePath: String?): Set<String> {
      return try {
        val pm = activity.packageManager
        val pkgInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          val flags = PackageManager.GET_SIGNING_CERTIFICATES.toLong()
          if (archivePath == null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              pm.getPackageInfo(activity.packageName, PackageManager.PackageInfoFlags.of(flags))
            } else {
              @Suppress("DEPRECATION")
              pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            }
          } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
              pm.getPackageArchiveInfo(archivePath, PackageManager.PackageInfoFlags.of(flags))
            } else {
              @Suppress("DEPRECATION")
              pm.getPackageArchiveInfo(archivePath, PackageManager.GET_SIGNING_CERTIFICATES)
            }
          }
        } else {
          @Suppress("DEPRECATION")
          if (archivePath == null) {
            pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
          } else {
            pm.getPackageArchiveInfo(archivePath, PackageManager.GET_SIGNATURES)
          }
        } ?: return emptySet()

        val rawSigs = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          pkgInfo.signingInfo?.apkContentsSigners ?: pkgInfo.signingInfo?.signingCertificateHistory
        } else {
          @Suppress("DEPRECATION")
          pkgInfo.signatures
        } ?: return emptySet()

        val md = java.security.MessageDigest.getInstance("SHA-256")
        rawSigs.map { sig ->
          md.digest(sig.toByteArray()).joinToString("") { b -> "%02x".format(b) }
        }.toSet()
      } catch (_: Exception) {
        emptySet()
      }
    }

    @JavascriptInterface
    fun getCachedOtaApkInfo(fileName: String, expectedSize: Long): String {
      return try {
        val cleanName = sanitizeOtaApkName(fileName)
        val updatesDir = File(activity.cacheDir, "updates")
        val apkFile = File(updatesDir, cleanName)
        if (!apkFile.exists()) {
          return JSONObject().apply { put("ready", false) }.toString()
        }
        val err = validateOtaApkFile(apkFile, expectedSize)
        if (err != null) {
          return JSONObject().apply { put("ready", false) }.toString()
        }
        JSONObject().apply {
          put("ready", true)
          put("filePath", apkFile.absolutePath)
          put("size", apkFile.length())
        }.toString()
      } catch (_: Exception) {
        JSONObject().apply { put("ready", false) }.toString()
      }
    }

    private fun isAllowedOtaUrl(rawUrl: String, isRedirectHop: Boolean): Boolean {
      if (rawUrl.contains("..") || rawUrl.contains("\\")) return false
      val uri = try { URI(rawUrl).normalize() } catch (_: Exception) { return false }
      if (!"https".equals(uri.scheme, ignoreCase = true)) return false
      if (uri.userInfo != null) return false
      if (uri.port != -1 && uri.port != 443) return false
      val host = (uri.host ?: "").lowercase()
      val normPath = uri.path ?: ""
      if (!isRedirectHop) {
        return host == "github.com" && normPath.startsWith("/cozgams/AuraStream/releases/download/")
      }
      if (host == "github.com") {
        return normPath.startsWith("/cozgams/AuraStream/")
      }
      return host == "objects.githubusercontent.com" ||
        host == "release-assets.githubusercontent.com" ||
        host == "github-releases.githubusercontent.com" ||
        host.endsWith(".githubusercontent.com")
    }

    @JavascriptInterface
    fun getDeviceAbi(): String {
      for (abi in Build.SUPPORTED_ABIS) {
        when (abi.lowercase()) {
          "arm64-v8a" -> return "arm64"
          "x86_64" -> return "x86_64"
          "armeabi-v7a", "armeabi" -> return "arm"
        }
      }
      return "arm64"
    }

    @JavascriptInterface
    fun canInstallPackages(): Boolean {
      return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        try {
          activity.packageManager.canRequestPackageInstalls()
        } catch (_: Exception) {
          false
        }
      } else {
        true
      }
    }

    @JavascriptInterface
    fun openInstallPermissionSettings(): Boolean {
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}")
          ).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          activity.startActivity(intent)
        }
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun cancelOtaDownload(): Boolean {
      otaCancelled = true
      otaDownloadToken.incrementAndGet()
      try {
        otaActiveConnection?.disconnect()
      } catch (_: Exception) {}
      otaActiveConnection = null
      return true
    }

    @JavascriptInterface
    fun startOtaDownload(url: String, fileName: String): Boolean {
      if (!isAllowedOtaUrl(url, isRedirectHop = false)) {
        dispatchOtaEvent(JSONObject().apply {
          put("status", "error")
          put("error", "Blocked untrusted update download URL")
        })
        return false
      }

      cancelOtaDownload()
      val myToken = otaDownloadToken.incrementAndGet()
      otaCancelled = false
      val cleanName = sanitizeOtaApkName(fileName)

      Thread {
        var partFile: File? = null
        var myConn: HttpURLConnection? = null
        try {
          activity.acquireWakeLock()
          val updatesDir = File(activity.cacheDir, "updates")
          if (!updatesDir.exists()) updatesDir.mkdirs()
          updatesDir.listFiles()?.forEach { oldFile ->
            val keepFile = oldFile.name == cleanName || oldFile.name.endsWith(".$myToken.part")
            if (oldFile.isFile && !keepFile) {
              try { oldFile.delete() } catch (_: Exception) {}
            }
          }

          val apkFile = File(updatesDir, cleanName)
          if (apkFile.exists() && validateOtaApkFile(apkFile, 0L) == null) {
            dispatchOtaEvent(JSONObject().apply {
              put("status", "downloaded")
              put("progress", 100)
              put("downloadedBytes", apkFile.length())
              put("totalBytes", apkFile.length())
              put("speedBytesPerSec", 0L)
              put("filePath", apkFile.absolutePath)
            })
            return@Thread
          }

          partFile = File(updatesDir, "$cleanName.$myToken.part")
          dispatchOtaEvent(JSONObject().apply {
            put("status", "downloading")
            put("progress", 0)
            put("downloadedBytes", 0L)
            put("totalBytes", 0L)
            put("speedBytesPerSec", 0L)
          })

          var expectedTotalBytes = 0L
          var lastError: Exception? = null

          for (attempt in 1..3) {
            if (otaCancelled || otaDownloadToken.get() != myToken) {
              throw InterruptedException("cancelled")
            }
            val resumeOffset = if (partFile.exists()) partFile.length() else 0L
            try {
              var currentUrl = url
              var conn: HttpURLConnection? = null
              for (hop in 0..6) {
                if (otaCancelled || otaDownloadToken.get() != myToken) {
                  throw InterruptedException("cancelled")
                }
                if (!isAllowedOtaUrl(currentUrl, isRedirectHop = hop > 0)) {
                  throw SecurityException("Redirected to untrusted update host")
                }
                val nextConn = (URL(currentUrl).openConnection() as HttpURLConnection).apply {
                  instanceFollowRedirects = false
                  connectTimeout = 20_000
                  readTimeout = 30_000
                  setRequestProperty("User-Agent", "AuraStream-Android-OTA")
                  setRequestProperty("Accept", "application/octet-stream, application/vnd.android.package-archive")
                  if (resumeOffset > 0L) {
                    setRequestProperty("Range", "bytes=$resumeOffset-")
                  }
                }
                myConn = nextConn
                otaActiveConnection = nextConn
                val code = nextConn.responseCode
                if (code in listOf(301, 302, 303, 307, 308)) {
                  val loc = nextConn.getHeaderField("Location") ?: throw IllegalStateException("Redirect missing Location")
                  nextConn.disconnect()
                  currentUrl = URL(URL(currentUrl), loc).toString()
                  continue
                }
                conn = nextConn
                break
              }

              val finalConn = conn ?: throw IllegalStateException("Too many redirects while fetching update")
              val responseCode = finalConn.responseCode
              if (responseCode != HttpURLConnection.HTTP_OK && responseCode != HttpURLConnection.HTTP_PARTIAL) {
                throw IllegalStateException("Update server returned HTTP $responseCode")
              }

              val isPartialAppend = responseCode == HttpURLConnection.HTTP_PARTIAL && resumeOffset > 0L
              if (!isPartialAppend && partFile.exists()) {
                partFile.delete()
              }

              var downloadedBytes = if (isPartialAppend) resumeOffset else 0L
              val contentLen = finalConn.contentLengthLong.coerceAtLeast(0L)
              val contentRange = finalConn.getHeaderField("Content-Range") ?: ""
              val rangeTotal = contentRange.substringAfter("/", "").toLongOrNull() ?: 0L
              val totalBytes = when {
                rangeTotal > 0L -> rangeTotal
                isPartialAppend && contentLen > 0L -> resumeOffset + contentLen
                contentLen > 0L -> contentLen
                else -> expectedTotalBytes
              }
              if (totalBytes > 0L) expectedTotalBytes = totalBytes

              var lastEmitMs = 0L
              var lastPct = -1
              var sampleStartMs = System.currentTimeMillis()
              var sampleStartBytes = downloadedBytes
              var currentSpeedBps = 0L

              finalConn.inputStream.use { input ->
                FileOutputStream(partFile, isPartialAppend).use { output ->
                  val buffer = ByteArray(32 * 1024)
                  while (true) {
                    if (otaCancelled || otaDownloadToken.get() != myToken) {
                      throw InterruptedException("cancelled")
                    }
                    val read = input.read(buffer)
                    if (read == -1) break
                    output.write(buffer, 0, read)
                    downloadedBytes += read

                    val now = System.currentTimeMillis()
                    val speedElapsedMs = now - sampleStartMs
                    if (speedElapsedMs >= 450L) {
                      val bytesDelta = (downloadedBytes - sampleStartBytes).coerceAtLeast(0L)
                      val instantSpeed = (bytesDelta * 1000L) / speedElapsedMs.coerceAtLeast(1L)
                      currentSpeedBps = if (currentSpeedBps > 0L) {
                        (currentSpeedBps * 6L + instantSpeed * 4L) / 10L
                      } else {
                        instantSpeed
                      }
                      sampleStartMs = now
                      sampleStartBytes = downloadedBytes
                    }

                    val pct = if (totalBytes > 0L) {
                      ((downloadedBytes * 100L) / totalBytes).toInt().coerceIn(0, 99)
                    } else {
                      0
                    }
                    if (pct != lastPct || now - lastEmitMs >= 250L) {
                      lastPct = pct
                      lastEmitMs = now
                      dispatchOtaEvent(JSONObject().apply {
                        put("status", "downloading")
                        put("progress", pct)
                        put("downloadedBytes", downloadedBytes)
                        put("totalBytes", totalBytes)
                        put("speedBytesPerSec", currentSpeedBps)
                      })
                    }
                  }
                }
              }
              lastError = null
              break
            } catch (interrupted: InterruptedException) {
              throw interrupted
            } catch (sec: SecurityException) {
              throw sec
            } catch (e: Exception) {
              lastError = e
              try { myConn?.disconnect() } catch (_: Exception) {}
              if (attempt == 3 || otaCancelled || otaDownloadToken.get() != myToken) {
                throw e
              }
              try {
                Thread.sleep(1500L * attempt)
              } catch (_: InterruptedException) {
                throw InterruptedException("cancelled")
              }
            }
          }
          if (lastError != null) throw lastError

          if (otaCancelled || otaDownloadToken.get() != myToken) {
            try { partFile.delete() } catch (_: Exception) {}
            if (otaDownloadToken.get() == myToken && otaCancelled) {
              dispatchOtaEvent(JSONObject().apply { put("status", "cancelled") })
            }
            return@Thread
          }

          val validationErr = validateOtaApkFile(partFile, expectedTotalBytes)
          if (validationErr != null) {
            throw IllegalStateException(validationErr)
          }

          if (apkFile.exists()) apkFile.delete()
          if (!partFile.renameTo(apkFile)) {
            partFile.copyTo(apkFile, overwrite = true)
            partFile.delete()
          }

          dispatchOtaEvent(JSONObject().apply {
            put("status", "downloaded")
            put("progress", 100)
            put("downloadedBytes", apkFile.length())
            put("totalBytes", if (expectedTotalBytes > 0L) expectedTotalBytes else apkFile.length())
            put("speedBytesPerSec", 0L)
            put("filePath", apkFile.absolutePath)
          })
        } catch (_: InterruptedException) {
          try { partFile?.delete() } catch (_: Exception) {}
          if (otaDownloadToken.get() == myToken && otaCancelled) {
            dispatchOtaEvent(JSONObject().apply { put("status", "cancelled") })
          }
        } catch (e: Exception) {
          try { partFile?.delete() } catch (_: Exception) {}
          if (otaCancelled || otaDownloadToken.get() != myToken) {
            if (otaDownloadToken.get() == myToken && otaCancelled) {
              dispatchOtaEvent(JSONObject().apply { put("status", "cancelled") })
            }
          } else {
            dispatchOtaEvent(JSONObject().apply {
              put("status", "error")
              put("error", e.message ?: "Failed to download update")
            })
          }
        } finally {
          try { myConn?.disconnect() } catch (_: Exception) {}
          if (otaActiveConnection === myConn) {
            otaActiveConnection = null
          }
          if (activity.activeDownloadCount <= 0 && !AuraDownloadService.hasActiveDiskDownloads(activity)) {
            activity.releaseWakeLock()
          }
        }
      }.apply {
        name = "AuraOtaDownloader"
        start()
      }
      return true
    }

    @JavascriptInterface
    fun installDownloadedApk(filePath: String): String {
      return try {
        val updatesDir = File(activity.cacheDir, "updates").canonicalFile
        val apkFile = File(filePath).canonicalFile
        if (!apkFile.path.startsWith(updatesDir.path + File.separator) || !apkFile.exists() || !apkFile.isFile) {
          return "ERROR:Downloaded update file not found"
        }
        val err = validateOtaApkFile(apkFile, 0L)
        if (err != null) {
          try { apkFile.delete() } catch (_: Exception) {}
          return "ERROR:$err"
        }
        if (!canInstallPackages()) {
          return "NEED_PERMISSION"
        }
        val uri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          apkFile
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        "STARTED"
      } catch (e: Exception) {
        e.printStackTrace()
        "ERROR:${e.message ?: "Failed to launch installer"}"
      }
    }

    @JavascriptInterface
    fun getPermissionsStatus(): String {
      val notifsEnabled = try {
        val enabledByOs = androidx.core.app.NotificationManagerCompat.from(activity).areNotificationsEnabled()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          enabledByOs && activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
          enabledByOs
        }
      } catch (_: Exception) {
        false
      }

      val batteryIgnored = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          val pm = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager
          pm?.isIgnoringBatteryOptimizations(activity.packageName) == true
        } else {
          true
        }
      } catch (_: Exception) {
        false
      }

      val storageGranted = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          true
        } else {
          activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }
      } catch (_: Exception) {
        true
      }

      return JSONObject().apply {
        put("notificationsGranted", notifsEnabled)
        put("batteryOptimizationIgnored", batteryIgnored)
        put("canInstallPackages", canInstallPackages())
        put("storageGranted", storageGranted)
        put("androidSdk", Build.VERSION.SDK_INT)
        put("manufacturer", Build.MANUFACTURER ?: "")
      }.toString()
    }

    @JavascriptInterface
    fun requestNotificationPermissionNow(): Boolean {
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          val granted = activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
          val prefs = activity.getSharedPreferences("aurastream_perms", Context.MODE_PRIVATE)
          val askedBefore = prefs.getBoolean("asked_notif", false)
          if (!granted && (!askedBefore || activity.shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS))) {
            prefs.edit().putBoolean("asked_notif", true).apply()
            activity.runOnUiThread {
              activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
            return true
          }
        }
        val intent = Intent().apply {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            action = Settings.ACTION_APP_NOTIFICATION_SETTINGS
            putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
          } else {
            action = Settings.ACTION_APPLICATION_DETAILS_SETTINGS
            data = Uri.parse("package:${activity.packageName}")
          }
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun requestIgnoreBatteryOptimizations(): Boolean {
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          val pm = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager
          if (pm?.isIgnoringBatteryOptimizations(activity.packageName) == true) {
            return true
          }
          try {
            val intent = Intent(
              Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              Uri.parse("package:${activity.packageName}")
            ).apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            return true
          } catch (_: Exception) {
            val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(fallback)
            return true
          }
        }
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun requestLegacyStoragePermission(): Boolean {
      return try {
        when {
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> true
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> {
            if (activity.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
              activity.runOnUiThread {
                activity.requestPermissions(arrayOf(android.Manifest.permission.READ_EXTERNAL_STORAGE), 102)
              }
            }
            true
          }
          else -> {
            if (activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
              activity.runOnUiThread {
                activity.requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE, android.Manifest.permission.READ_EXTERNAL_STORAGE), 102)
              }
            }
            true
          }
        }
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun openAppSettings(): Boolean {
      return try {
        val intent = Intent(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.parse("package:${activity.packageName}")
        ).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        true
      } catch (e: Exception) {
        e.printStackTrace()
        false
      }
    }

    @JavascriptInterface
    fun openCaptionSettings(): Boolean {
      return try {
        val intent = Intent(Settings.ACTION_CAPTIONING_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        true
      } catch (_: Exception) {
        try {
          val fallback = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          }
          activity.startActivity(fallback)
          true
        } catch (e2: Exception) {
          e2.printStackTrace()
          false
        }
      }
    }
  }
}
