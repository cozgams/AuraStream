package com.aurastream.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Android Foreground Service for AuraStream background media downloads.
 * Polls Rust engine disk status directly (active_status.json) so downloads and
 * progress notifications continue uninterrupted even when WebView is backgrounded or locked.
 */
class AuraDownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var poller: ScheduledExecutorService? = null
  private var idleTicks: Int = 0
  @Volatile
  private var nativeOwnsQueue: Boolean = false
  @Volatile
  private var lastNativeUpdatedAt: Long = 0L

  data class DownloadItem(
    val id: Int,
    val title: String,
    val subtitle: String,
    val progress: Int,
    val speed: String,
    val size: String,
    val status: String = "downloading"
  )

  companion object {
    const val CHANNEL_ID = "aurastream_downloads_v2"
    const val COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_v2"
    const val NOTIFICATION_ID = 9001
    const val ACTION_START = "com.aurastream.app.action.START_DOWNLOAD"
    const val ACTION_UPDATE = "com.aurastream.app.action.UPDATE_DOWNLOAD"
    const val ACTION_STOP = "com.aurastream.app.action.STOP_DOWNLOAD"
    const val ACTION_PAUSE_ALL = "com.aurastream.app.action.PAUSE_ALL"
    const val ACTION_CANCEL_ALL = "com.aurastream.app.action.CANCEL_ALL"

    const val EXTRA_ID = "extra_id"
    const val EXTRA_TITLE = "extra_title"
    const val EXTRA_SUBTITLE = "extra_subtitle"
    const val EXTRA_PROGRESS = "extra_progress"
    const val EXTRA_SPEED = "extra_speed"
    const val EXTRA_SIZE = "extra_size"
    const val EXTRA_COUNT = "extra_count"

    @Volatile
    var isRunning: Boolean = false
      private set

    @Volatile
    var instance: AuraDownloadService? = null
      private set

    private val activeDownloads = LinkedHashMap<Int, DownloadItem>()
    private val notifiedCompleted = Collections.synchronizedSet(LinkedHashSet<String>())

    @Volatile
    private var nativeTotalQueuedCount: Int = 0

    @Synchronized
    fun upsertDownload(
      id: Int,
      title: String,
      subtitle: String,
      progress: Int,
      speed: String,
      size: String,
      status: String = "downloading"
    ) {
      activeDownloads[id] = DownloadItem(
        id = id,
        title = title,
        subtitle = subtitle,
        progress = progress.coerceIn(0, 100),
        speed = speed,
        size = size,
        status = status
      )
    }

    @Synchronized
    fun replaceAllFromNative(items: List<DownloadItem>, queuedCount: Int) {
      activeDownloads.clear()
      for (item in items) {
        activeDownloads[item.id] = item
      }
      nativeTotalQueuedCount = queuedCount
    }

    @Synchronized
    fun removeDownload(id: Int) {
      activeDownloads.remove(id)
    }

    @Synchronized
    fun clearDownloads() {
      activeDownloads.clear()
      nativeTotalQueuedCount = 0
    }

    @Synchronized
    private fun snapshotDownloads(): List<DownloadItem> {
      return activeDownloads.values.toList()
    }

    fun findOfflineDir(context: Context): File {
      val candidates = mutableListOf(
        File(context.filesDir, "offline_downloads"),
        File(context.dataDir, "offline_downloads")
      )
      var bestDir = candidates.first()
      var bestTime = -1L
      for (dir in candidates) {
        val statusFile = File(dir, "active_status.json")
        if (statusFile.isFile && statusFile.lastModified() > bestTime) {
          bestTime = statusFile.lastModified()
          bestDir = dir
        } else if (dir.isDirectory && bestTime < 0L) {
          bestDir = dir
        }
      }
      return bestDir
    }

    fun hasActiveDiskDownloads(context: Context): Boolean {
      val statusFile = File(findOfflineDir(context), "active_status.json")
      if (!statusFile.isFile) return false
      return try {
        val json = JSONObject(statusFile.readText(Charsets.UTF_8))
        json.optInt("activeCount", 0) > 0 || json.optInt("queuedCount", 0) > 0
      } catch (_: Exception) {
        false
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    isRunning = true
    acquireLocks()
    createNotificationChannels()
    startDiskPoller()
  }

  private fun acquireLocks() {
    try {
      if (wakeLock == null) {
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuraStream::DownloadServiceWakeLock")?.apply {
          setReferenceCounted(false)
        }
      }
      if (wakeLock?.isHeld != true) {
        wakeLock?.acquire(4 * 60 * 60 * 1000L)
      }
    } catch (_: Exception) {}

    try {
      if (wifiLock == null) {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
          @Suppress("DEPRECATION")
          WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wm?.createWifiLock(lockMode, "AuraStream::DownloadWifiLock")?.apply {
          setReferenceCounted(false)
        }
      }
      if (wifiLock?.isHeld != true) {
        wifiLock?.acquire()
      }
    } catch (_: Exception) {}
  }

  private fun releaseLocks() {
    try {
      if (wakeLock?.isHeld == true) {
        wakeLock?.release()
      }
    } catch (_: Exception) {}
    wakeLock = null

    try {
      if (wifiLock?.isHeld == true) {
        wifiLock?.release()
      }
    } catch (_: Exception) {}
    wifiLock = null
  }

  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val progressChannel = NotificationChannel(
        CHANNEL_ID,
        "Background Downloads",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Shows active and queued episode downloads"
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
      }
      manager.createNotificationChannel(progressChannel)

      val completeChannel = NotificationChannel(
        COMPLETE_CHANNEL_ID,
        "Completed Downloads",
        NotificationManager.IMPORTANCE_DEFAULT
      ).apply {
        description = "Alerts when offline episodes finish downloading"
        setShowBadge(true)
      }
      manager.createNotificationChannel(completeChannel)
    }
  }

  private fun writeControlAction(action: String) {
    try {
      val dir = findOfflineDir(this)
      if (!dir.exists()) dir.mkdirs()
      val tmp = File(dir, "control.json.tmp")
      val dst = File(dir, "control.json")
      tmp.writeText(JSONObject().apply { put("action", action) }.toString(), Charsets.UTF_8)
      if (!tmp.renameTo(dst)) {
        tmp.copyTo(dst, overwrite = true)
        tmp.delete()
      }
    } catch (_: Exception) {}
  }

  private fun startDiskPoller() {
    if (poller != null) return
    val exec = Executors.newSingleThreadScheduledExecutor()
    poller = exec
    exec.scheduleWithFixedDelay({
      if (!isRunning) return@scheduleWithFixedDelay
      try {
        pollNativeStatusFromDisk()
      } catch (_: Exception) {}
    }, 800L, 1000L, TimeUnit.MILLISECONDS)
  }

  private fun stopDiskPoller() {
    try {
      poller?.shutdownNow()
    } catch (_: Exception) {}
    poller = null
  }

  private fun pollNativeStatusFromDisk() {
    val statusFile = File(findOfflineDir(this), "active_status.json")
    if (!statusFile.isFile) return
    val raw = try {
      statusFile.readText(Charsets.UTF_8)
    } catch (_: Exception) {
      return
    }
    if (raw.isBlank()) return
    val json = try {
      JSONObject(raw)
    } catch (_: Exception) {
      return
    }

    val activeCount = json.optInt("activeCount", 0)
    val queuedCount = json.optInt("queuedCount", 0)
    val updatedAt = json.optLong("updatedAt", 0L)
    val itemsArr = json.optJSONArray("items") ?: JSONArray()
    val parsedItems = ArrayList<DownloadItem>(itemsArr.length())
    for (i in 0 until itemsArr.length()) {
      val obj = itemsArr.optJSONObject(i) ?: continue
      val vid = obj.optInt("videoId", 0)
      val ep = obj.optInt("episode", 1)
      val notifItemId = ((kotlin.math.abs(vid) % 10000) * 100 + (ep % 100)) and 0x7fffffff
      parsedItems.add(
        DownloadItem(
          id = notifItemId,
          title = obj.optString("title", "AuraStream"),
          subtitle = obj.optString("subtitle", "Episode $ep"),
          progress = obj.optInt("progress", 0).coerceIn(0, 100),
          speed = obj.optString("speed", ""),
          size = obj.optString("size", ""),
          status = obj.optString("status", "downloading")
        )
      )
    }

    // Emit completion notifications when running in background
    val recentArr = json.optJSONArray("recentCompleted")
    if (recentArr != null) {
      for (i in 0 until recentArr.length()) {
        val comp = recentArr.optJSONObject(i) ?: continue
        val compId = comp.optString("id", "")
        val compAt = comp.optLong("completedAt", 0L)
        if (compId.isEmpty() || compAt <= 0L) continue
        val dedupeKey = "$compId:$compAt"
        if (notifiedCompleted.contains(dedupeKey)) continue
        if (System.currentTimeMillis() - compAt > 15_000L) {
          notifiedCompleted.add(dedupeKey)
          continue
        }
        notifiedCompleted.add(dedupeKey)
        if (notifiedCompleted.size > 100) {
          val first = notifiedCompleted.firstOrNull()
          if (first != null) notifiedCompleted.remove(first)
        }
        if (!MainActivity.isForegroundGlobal) {
          showCompletionBanner(
            vid = comp.optInt("videoId", 0),
            ep = comp.optInt("episode", 1),
            title = comp.optString("title", "AuraStream"),
            subtitle = comp.optString("subtitle", "Episode 1"),
            size = comp.optString("size", "")
          )
        }
      }
    }

    if (activeCount > 0 || queuedCount > 0) {
      nativeOwnsQueue = true
      lastNativeUpdatedAt = updatedAt
      idleTicks = 0
      replaceAllFromNative(parsedItems, queuedCount)
      refreshNotification(maxOf(activeCount, parsedItems.size))
    } else {
      if (nativeOwnsQueue || (updatedAt > 0L && updatedAt != lastNativeUpdatedAt)) {
        nativeOwnsQueue = false
        lastNativeUpdatedAt = updatedAt
        clearDownloads()
      }
      if (snapshotDownloads().isEmpty()) {
        idleTicks++
        if (idleTicks >= 3) {
          stopServiceCleanly()
        }
      }
    }
  }

  private fun showCompletionBanner(vid: Int, ep: Int, title: String, subtitle: String, size: String) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        return
      }
      val notifId = (((kotlin.math.abs(vid) % 10000) * 100 + (ep % 100)) and 0x7fffffff) + 1_000_000
      val launchIntent = Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      val pi = PendingIntent.getActivity(
        this,
        notifId,
        launchIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val sizeSuffix = if (size.isNotEmpty()) " ($size)" else ""
      val notification = NotificationCompat.Builder(this, COMPLETE_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle("Saved: $title")
        .setContentText("$subtitle$sizeSuffix ready for offline viewing")
        .setContentIntent(pi)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        .build()
      NotificationManagerCompat.from(this).notify(notifId, notification)
    } catch (_: Exception) {}
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      // Service restarted by Android; resume polling native disk state if still active
      pollNativeStatusFromDisk()
      return START_REDELIVER_INTENT
    }
    when (intent.action) {
      ACTION_STOP -> {
        stopServiceCleanly()
        return START_NOT_STICKY
      }
      ACTION_PAUSE_ALL -> {
        writeControlAction("pause_all")
        stopServiceCleanly()
        return START_NOT_STICKY
      }
      ACTION_CANCEL_ALL -> {
        writeControlAction("cancel_all")
        stopServiceCleanly()
        return START_NOT_STICKY
      }
      ACTION_START, ACTION_UPDATE -> {
        idleTicks = 0
        val id = intent.getIntExtra(EXTRA_ID, -1)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: "AuraStream"
        val subtitle = intent.getStringExtra(EXTRA_SUBTITLE) ?: "Downloading..."
        val progress = intent.getIntExtra(EXTRA_PROGRESS, 0).coerceIn(0, 100)
        val speed = intent.getStringExtra(EXTRA_SPEED) ?: ""
        val size = intent.getStringExtra(EXTRA_SIZE) ?: ""
        val count = intent.getIntExtra(EXTRA_COUNT, 1)

        if (id != -1) {
          upsertDownload(id, title, subtitle, progress, speed, size)
        }

        val notification = buildForegroundNotification(title, subtitle, progress, speed, size, count)
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
          } else {
            startForeground(NOTIFICATION_ID, notification)
          }
        } catch (e: Exception) {
          e.printStackTrace()
          try {
            startForeground(NOTIFICATION_ID, notification)
          } catch (e2: Exception) {
            e2.printStackTrace()
            stopServiceCleanly()
            return START_NOT_STICKY
          }
        }
      }
      else -> {
        if (!isRunning) {
          stopServiceCleanly()
        }
      }
    }
    return START_REDELIVER_INTENT
  }

  fun refreshNotification(reportedCount: Int) {
    if (!isRunning) return
    try {
      val notification = buildForegroundNotification("AuraStream", "Downloading...", 0, "", "", reportedCount)
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      manager?.notify(NOTIFICATION_ID, notification)
    } catch (_: Exception) {}
  }

  private fun buildForegroundNotification(
    fallbackTitle: String,
    fallbackSubtitle: String,
    fallbackProgress: Int,
    fallbackSpeed: String,
    fallbackSize: String,
    reportedCount: Int
  ): Notification {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val pauseIntent = PendingIntent.getService(
      this,
      101,
      Intent(this, AuraDownloadService::class.java).apply { action = ACTION_PAUSE_ALL },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val cancelIntent = PendingIntent.getService(
      this,
      102,
      Intent(this, AuraDownloadService::class.java).apply { action = ACTION_CANCEL_ALL },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val items = snapshotDownloads()
    val activeItems = items.filter { it.status == "downloading" }.ifEmpty { items }
    val displayCount = maxOf(reportedCount, items.size)

    val contentTitle: String
    val contentText: String
    val bigText: String
    val progressValue: Int

    if (items.size > 1) {
      val activeItem = activeItems.first()
      val p = activeItem.progress.coerceIn(0, 100)
      contentTitle = "Downloading ${items.size} episodes"
      val extra = listOf(activeItem.size, activeItem.speed).filter { it.isNotEmpty() }.joinToString(" · ")
      contentText = "${activeItem.title} (${activeItem.subtitle}) · $p%${if (extra.isNotEmpty()) " · $extra" else ""}"
      val lines = items.take(4).joinToString("\n") { item ->
        if (item.status == "queued") {
          "${item.title} (${item.subtitle}) · Queued"
        } else {
          val ip = item.progress.coerceIn(0, 100)
          val itemExtra = listOf(item.size, item.speed).filter { it.isNotEmpty() }.joinToString(" · ")
          if (itemExtra.isNotEmpty()) "${item.title} (${item.subtitle}) · $ip% · $itemExtra"
          else "${item.title} (${item.subtitle}) · $ip%"
        }
      }
      bigText = if (items.size > 4) "$lines\n+${items.size - 4} more in queue" else lines
      progressValue = p
    } else if (items.size == 1) {
      val item = items.first()
      val clamped = item.progress.coerceIn(0, 100)
      val details = listOf(item.size, item.speed).filter { it.isNotEmpty() }.joinToString(" · ")
      contentTitle = if (displayCount > 1) "Downloading ($displayCount) · ${item.title}" else "Downloading: ${item.title}"
      contentText = if (details.isNotEmpty()) "${item.subtitle} · $clamped% · $details" else "${item.subtitle} · $clamped%"
      bigText = contentText
      progressValue = clamped
    } else {
      val clamped = fallbackProgress.coerceIn(0, 100)
      val details = listOf(fallbackSize, fallbackSpeed).filter { it.isNotEmpty() }.joinToString(" · ")
      contentTitle = if (displayCount > 1) "Downloading ($displayCount) · $fallbackTitle" else "Downloading: $fallbackTitle"
      contentText = if (details.isNotEmpty()) "$fallbackSubtitle · $clamped% · $details" else "$fallbackSubtitle · $clamped%"
      bigText = contentText
      progressValue = clamped
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(contentTitle)
      .setContentText(contentText)
      .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
      .setProgress(100, progressValue, progressValue <= 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setContentIntent(pendingIntent)
      .addAction(android.R.drawable.ic_media_pause, "Pause All", pauseIntent)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  private fun stopServiceCleanly() {
    clearDownloads()
    nativeOwnsQueue = false
    isRunning = false
    instance = null
    MainActivity.serviceStartRequested = false
    stopDiskPoller()
    releaseLocks()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    // Keep Foreground Service alive if active or queued downloads are still running!
    val hasActiveDisk = hasActiveDiskDownloads(this)
    if (!hasActiveDisk && (nativeOwnsQueue || snapshotDownloads().isEmpty())) {
      stopServiceCleanly()
    }
  }

  override fun onDestroy() {
    stopDiskPoller()
    releaseLocks()
    isRunning = false
    instance = null
    MainActivity.serviceStartRequested = false
    super.onDestroy()
  }
}
