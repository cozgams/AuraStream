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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Android Foreground Service for AuraStream background media downloads.
 * Polls Rust engine disk status directly (active_status.json) so downloads and
 * progress notifications continue silently and reliably when WebView is backgrounded.
 */
class AuraDownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var poller: ScheduledExecutorService? = null
  private val idleTicks = AtomicInteger(0)
  private val mainHandler = Handler(Looper.getMainLooper())
  @Volatile
  private var lastStartId: Int = -1
  @Volatile
  private var isInForeground: Boolean = false
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
    val status: String = "downloading",
    val eta: String = "",
    val speedBps: Long = 0L
  )

  companion object {
    const val CHANNEL_ID = "aurastream_downloads_silent_v7"
    const val COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_silent_v7"
    private const val LEGACY_SILENT_V6_CHANNEL_ID = "aurastream_downloads_silent_v6"
    private const val LEGACY_SILENT_V6_COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_silent_v6"
    private const val LEGACY_SILENT_V5_CHANNEL_ID = "aurastream_downloads_silent_v5"
    private const val LEGACY_SILENT_V5_COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_silent_v5"
    private const val LEGACY_SILENT_V4_CHANNEL_ID = "aurastream_downloads_silent_v4"
    private const val LEGACY_SILENT_V4_COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_silent_v4"
    private const val LEGACY_SILENT_V3_CHANNEL_ID = "aurastream_downloads_silent_v3"
    private const val LEGACY_SILENT_V3_COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_silent_v3"
    private const val LEGACY_CHANNEL_ID = "aurastream_downloads_v2"
    private const val LEGACY_COMPLETE_CHANNEL_ID = "aurastream_downloads_complete_v2"
    private const val LEGACY_OLD_CHANNEL_ID = "aurastream_downloads"

    const val NOTIFICATION_ID = 9001
    const val COMPLETE_NOTIFICATION_ID = 9002
    private const val MIN_NOTIFY_INTERVAL_MS = 650L

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
    private val recentCompletedSummary = ArrayList<String>()

    @Volatile
    private var nativeTotalQueuedCount: Int = 0
    @Volatile
    private var sessionCompletedCount: Int = 0
    @Volatile
    private var sessionInitialTotal: Int = 0
    private val notifyLock = Any()
    private var lastForegroundNotifyAtMs: Long = 0L

    @JvmStatic
    fun ensureSilentChannels(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        try {
          val channels = manager.notificationChannels
          for (ch in channels) {
            if (ch.id != CHANNEL_ID && ch.id != COMPLETE_CHANNEL_ID && ch.id.contains("download", ignoreCase = true)) {
              try { manager.deleteNotificationChannel(ch.id) } catch (_: Exception) {}
            }
          }
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V6_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V6_COMPLETE_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V5_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V5_COMPLETE_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V4_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V4_COMPLETE_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V3_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_SILENT_V3_COMPLETE_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_COMPLETE_CHANNEL_ID)
        } catch (_: Exception) {}
        try {
          manager.deleteNotificationChannel(LEGACY_OLD_CHANNEL_ID)
        } catch (_: Exception) {}

        val progressChannel = NotificationChannel(
          CHANNEL_ID,
          "Active Downloads",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "Silent progress for active and queued downloads"
          setShowBadge(false)
          enableVibration(false)
          vibrationPattern = null
          enableLights(false)
          setSound(null, null)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(progressChannel)

        val completeChannel = NotificationChannel(
          COMPLETE_CHANNEL_ID,
          "Completed Downloads",
          NotificationManager.IMPORTANCE_LOW
        ).apply {
          description = "Silently summarizes episodes saved for offline viewing"
          setShowBadge(false)
          enableVibration(false)
          vibrationPattern = null
          enableLights(false)
          setSound(null, null)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(completeChannel)
      }
    }

    @Synchronized
    fun clearCompletedSummary() {
      recentCompletedSummary.clear()
    }

    @Synchronized
    private fun appendCompletedSummary(entry: String): List<String> {
      recentCompletedSummary.remove(entry)
      recentCompletedSummary.add(0, entry)
      while (recentCompletedSummary.size > 12) {
        recentCompletedSummary.removeAt(recentCompletedSummary.size - 1)
      }
      return recentCompletedSummary.toList()
    }

    @JvmStatic
    fun showSilentCompletionBanner(context: Context, title: String, subtitle: String, size: String) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
          context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
          return
        }
        ensureSilentChannels(context)
        val sizeSuffix = if (size.isNotEmpty()) " ($size)" else ""
        val entry = "$title · $subtitle$sizeSuffix"
        val entries = appendCompletedSummary(entry)

        val launchIntent = Intent(context, MainActivity::class.java).apply {
          flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
          context,
          COMPLETE_NOTIFICATION_ID,
          launchIntent,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, COMPLETE_CHANNEL_ID)
          .setSmallIcon(android.R.drawable.stat_sys_download_done)
          .setColor(0xFF1A73E8.toInt())
          .setContentIntent(pi)
          .setOngoing(false)
          .setAutoCancel(true)
          .setOnlyAlertOnce(true)
          .setSilent(true)
          .setSound(null)
          .setVibrate(null)
          .setDefaults(0)
          .setPriority(NotificationCompat.PRIORITY_LOW)
          .setCategory(NotificationCompat.CATEGORY_SERVICE)
          .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        if (entries.size <= 1) {
          builder
            .setContentTitle("Saved for Offline Viewing")
            .setContentText(entry)
            .setSubText("Completed")
        } else {
          val inbox = NotificationCompat.InboxStyle()
          entries.take(5).forEach { inbox.addLine(it) }
          if (entries.size > 5) {
            inbox.setSummaryText("+${entries.size - 5} more episodes saved")
          }
          builder
            .setContentTitle("${entries.size} Episodes Saved Offline")
            .setContentText(entries.first())
            .setSubText("Completed")
            .setNumber(entries.size)
            .setStyle(inbox)
        }

        NotificationManagerCompat.from(context).notify(COMPLETE_NOTIFICATION_ID, builder.build())
      } catch (_: Exception) {}
    }

    @Synchronized
    fun upsertDownload(
      id: Int,
      title: String,
      subtitle: String,
      progress: Int,
      speed: String,
      size: String,
      status: String = "downloading",
      eta: String = "",
      speedBps: Long = 0L
    ) {
      if (activeDownloads.isEmpty() && sessionInitialTotal == 0) {
        sessionInitialTotal = 1
      }
      activeDownloads[id] = DownloadItem(
        id = id,
        title = title,
        subtitle = subtitle,
        progress = progress.coerceIn(0, 100),
        speed = speed,
        size = size,
        status = status,
        eta = eta,
        speedBps = speedBps
      )
    }

    @Synchronized
    fun replaceAllFromNative(items: List<DownloadItem>, queuedCount: Int) {
      activeDownloads.clear()
      for (item in items) {
        activeDownloads[item.id] = item
      }
      nativeTotalQueuedCount = queuedCount
      val totalNow = items.size + queuedCount
      if (totalNow > sessionInitialTotal) {
        sessionInitialTotal = totalNow
      }
    }

    @Synchronized
    fun removeDownload(id: Int) {
      activeDownloads.remove(id)
      sessionCompletedCount++
    }

    @Synchronized
    fun clearDownloads() {
      activeDownloads.clear()
      nativeTotalQueuedCount = 0
      sessionCompletedCount = 0
      sessionInitialTotal = 0
    }

    @Synchronized
    private fun snapshotDownloads(): List<DownloadItem> {
      return activeDownloads.values.toList()
    }

    fun findOfflineDir(context: Context): File {
      val candidates = listOf(
        File(context.filesDir, "offline_downloads"),
        File(context.dataDir, "offline_downloads"),
        File(context.noBackupFilesDir, "offline_downloads")
      )
      for (dir in candidates) {
        val statusFile = File(dir, "active_status.json")
        if (statusFile.isFile && statusFile.length() > 0) {
          return dir
        }
      }
      for (dir in candidates) {
        if (dir.isDirectory) return dir
      }
      return candidates.first()
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

    fun computeNotifItemId(videoId: Int, episode: Int): Int {
      var h = (videoId * 131 + episode + 10000) and 0x7fffffff
      if (h < 10000 || h == NOTIFICATION_ID || h == COMPLETE_NOTIFICATION_ID) {
        h = (h + 10003) and 0x7fffffff
      }
      return h
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    isRunning = true
    acquireLocks()
    ensureSilentChannels(this)
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
      } catch (_: Throwable) {}
    }, 600L, 800L, TimeUnit.MILLISECONDS)
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
      val notifItemId = computeNotifItemId(vid, ep)
      parsedItems.add(
        DownloadItem(
          id = notifItemId,
          title = obj.optString("title", "AuraStream"),
          subtitle = obj.optString("subtitle", "Episode $ep"),
          progress = obj.optInt("progress", 0).coerceIn(0, 100),
          speed = obj.optString("speed", ""),
          size = obj.optString("size", ""),
          status = obj.optString("status", "downloading"),
          eta = obj.optString("eta", ""),
          speedBps = obj.optLong("speedBps", 0L)
        )
      )
    }

    // Update consolidated silent completion card when running in background
    val recentArr = json.optJSONArray("recentCompleted")
    if (recentArr != null) {
      for (i in 0 until recentArr.length()) {
        val comp = recentArr.optJSONObject(i) ?: continue
        val compId = comp.optString("id", "")
        val compAt = comp.optLong("completedAt", 0L)
        if (compId.isEmpty() || compAt <= 0L) continue
        val dedupeKey = "$compId:$compAt"
        val alreadyNotified = synchronized(notifiedCompleted) {
          if (notifiedCompleted.contains(dedupeKey)) {
            true
          } else {
            notifiedCompleted.add(dedupeKey)
            if (notifiedCompleted.size > 100) {
              val first = notifiedCompleted.firstOrNull()
              if (first != null) notifiedCompleted.remove(first)
            }
            false
          }
        }
        if (alreadyNotified || System.currentTimeMillis() - compAt > 15_000L) {
          continue
        }
        if (!MainActivity.isForegroundGlobal) {
          showSilentCompletionBanner(
            context = this,
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
      idleTicks.set(0)
      replaceAllFromNative(parsedItems, queuedCount)
      refreshNotification(maxOf(activeCount, parsedItems.size))
    } else {
      if (nativeOwnsQueue || (updatedAt > 0L && updatedAt != lastNativeUpdatedAt)) {
        nativeOwnsQueue = false
        lastNativeUpdatedAt = updatedAt
        clearDownloads()
      }
      if (snapshotDownloads().isEmpty()) {
        if (idleTicks.incrementAndGet() >= 3) {
          val targetStartId = lastStartId
          mainHandler.post { stopServiceCleanly(targetStartId) }
        }
      }
    }
  }

  private fun ensureForegroundStarted(notification: Notification) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      isInForeground = true
      synchronized(notifyLock) {
        lastForegroundNotifyAtMs = SystemClock.elapsedRealtime()
      }
    } catch (e: Exception) {
      e.printStackTrace()
      try {
        startForeground(NOTIFICATION_ID, notification)
        isInForeground = true
        synchronized(notifyLock) {
          lastForegroundNotifyAtMs = SystemClock.elapsedRealtime()
        }
      } catch (e2: Exception) {
        e2.printStackTrace()
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    lastStartId = startId
    if (intent == null) {
      if (!isInForeground) {
        ensureForegroundStarted(buildForegroundNotification("AuraStream", "Checking downloads...", 0, "", "", 0))
      }
      if (hasActiveDiskDownloads(this)) {
        pollNativeStatusFromDisk()
      } else {
        stopServiceCleanly(startId)
      }
      return START_NOT_STICKY
    }
    when (intent.action) {
      ACTION_STOP -> {
        if (!isInForeground) {
          ensureForegroundStarted(buildForegroundNotification("AuraStream", "Stopping downloads...", 0, "", "", 0))
          if (!isInForeground) {
            stopServiceCleanly(startId)
            return START_NOT_STICKY
          }
        }
        stopServiceCleanly(startId)
        return START_NOT_STICKY
      }
      ACTION_PAUSE_ALL -> {
        if (!isInForeground) {
          ensureForegroundStarted(buildForegroundNotification("AuraStream", "Pausing downloads...", 0, "", "", 0))
          if (!isInForeground) {
            stopServiceCleanly(startId)
            return START_NOT_STICKY
          }
        }
        writeControlAction("pause_all")
        mainHandler.postDelayed({ stopServiceCleanly(startId) }, 600L)
        return START_NOT_STICKY
      }
      ACTION_CANCEL_ALL -> {
        if (!isInForeground) {
          ensureForegroundStarted(buildForegroundNotification("AuraStream", "Cancelling downloads...", 0, "", "", 0))
          if (!isInForeground) {
            stopServiceCleanly(startId)
            return START_NOT_STICKY
          }
        }
        writeControlAction("cancel_all")
        mainHandler.postDelayed({ stopServiceCleanly(startId) }, 600L)
        return START_NOT_STICKY
      }
      ACTION_START, ACTION_UPDATE -> {
        idleTicks.set(0)
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
        ensureForegroundStarted(notification)
        if (!isInForeground) {
          stopServiceCleanly(startId)
          return START_NOT_STICKY
        }
      }
      else -> {
        if (!isInForeground) {
          ensureForegroundStarted(buildForegroundNotification("AuraStream", "AuraStream Downloads", 0, "", "", 0))
        }
        if (!isInForeground || !isRunning) {
          stopServiceCleanly(startId)
        }
      }
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    writeControlAction("pause_all")
    stopServiceCleanly(startId)
  }

  fun refreshNotification(reportedCount: Int) {
    if (!isRunning || !isInForeground) return
    val now = SystemClock.elapsedRealtime()
    synchronized(notifyLock) {
      if (now - lastForegroundNotifyAtMs < MIN_NOTIFY_INTERVAL_MS) return
      lastForegroundNotifyAtMs = now
    }
    try {
      val notification = buildForegroundNotification("AuraStream", "Downloading...", 0, "", "", reportedCount)
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      manager?.notify(NOTIFICATION_ID, notification)
    } catch (_: Exception) {}
  }

  private fun formatSpeedBps(bps: Long): String {
    if (bps <= 0L) return ""
    val mb = 1024.0 * 1024.0
    return if (bps >= 1024L * 1024L) {
      String.format(Locale.US, "%.1f MB/s", bps / mb)
    } else {
      String.format(Locale.US, "%d KB/s", maxOf(1L, bps / 1024L))
    }
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

    val pauseActionIntent = Intent(this, AuraDownloadService::class.java).apply { action = ACTION_PAUSE_ALL }
    val pauseIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(
        this,
        101,
        pauseActionIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } else {
      PendingIntent.getService(
        this,
        101,
        pauseActionIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val cancelActionIntent = Intent(this, AuraDownloadService::class.java).apply { action = ACTION_CANCEL_ALL }
    val cancelIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(
        this,
        102,
        cancelActionIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    } else {
      PendingIntent.getService(
        this,
        102,
        cancelActionIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    val items = snapshotDownloads()
    val activeItems = items.filter { it.status == "downloading" }
    val queuedItems = items.filter { it.status == "queued" }
    val totalQueuedCount = maxOf(queuedItems.size, nativeTotalQueuedCount)

    val contentTitle: String
    val contentText: String
    val subText: String
    val style: NotificationCompat.Style
    val progressValue: Int

    if (items.size > 1) {
      val lead = activeItems.firstOrNull() ?: items.first()
      val sumSpeed = activeItems.sumOf { it.speedBps }
      val combinedSpeed = formatSpeedBps(sumSpeed).ifEmpty {
        lead.speed.takeIf { it.isNotEmpty() && it != "Queued" && it != "--" } ?: ""
      }
      val completedWeight = sessionCompletedCount * 100
      val currentActiveWeight = activeItems.sumOf { it.progress }
      val batchTotal = maxOf(sessionInitialTotal, sessionCompletedCount + items.size)
      val avgProgress = if (batchTotal > 1) {
        ((completedWeight + currentActiveWeight) / batchTotal).coerceIn(0, 100)
      } else if (activeItems.isNotEmpty()) {
        (activeItems.sumOf { it.progress } / activeItems.size).coerceIn(0, 100)
      } else {
        lead.progress.coerceIn(0, 100)
      }

      val activeCount = activeItems.size.coerceAtLeast(1)
      contentTitle = if (totalQueuedCount > 0) {
        "Downloading $activeCount · $totalQueuedCount queued"
      } else {
        "Downloading $activeCount episodes"
      }
      subText = if (combinedSpeed.isNotEmpty()) "$avgProgress% · $combinedSpeed" else "$avgProgress%"

      val leadEta = lead.eta.takeIf { it.isNotEmpty() }?.let { " · $it left" } ?: ""
      contentText = "${lead.title} (${lead.subtitle}) · ${lead.progress}%$leadEta"

      val inbox = NotificationCompat.InboxStyle()
      for (item in items.take(5)) {
        if (item.status == "queued") {
          inbox.addLine("Queued · ${item.subtitle} · ${item.title}")
        } else {
          val ip = item.progress.coerceIn(0, 100)
          val spd = item.speed.takeIf { it.isNotEmpty() && it != "--" }?.let { " · $it" } ?: ""
          val etaStr = item.eta.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""
          inbox.addLine("${item.subtitle} · ${item.title} — $ip%$spd$etaStr")
        }
      }
      val remaining = maxOf(items.size, reportedCount) - 5
      if (remaining > 0) {
        inbox.setSummaryText("+$remaining more in queue")
      } else {
        inbox.setSummaryText("${activeItems.size} active · $totalQueuedCount queued")
      }
      style = inbox
      progressValue = avgProgress
    } else if (items.size == 1) {
      val item = items.first()
      val clamped = item.progress.coerceIn(0, 100)
      val cleanSpeed = item.speed.takeIf { it.isNotEmpty() && it != "Queued" && it != "--" }
      val etaPart = item.eta.takeIf { it.isNotEmpty() }?.let { "$it left" }
      subText = (listOf("$clamped%") + listOfNotNull(cleanSpeed, etaPart)).joinToString(" · ")
      contentTitle = item.title
      contentText = listOfNotNull(item.subtitle, item.size.takeIf { it.isNotEmpty() }).joinToString(" · ")
      style = NotificationCompat.BigTextStyle().bigText(contentText)
      progressValue = clamped
    } else {
      val clamped = fallbackProgress.coerceIn(0, 100)
      val cleanSpeed = fallbackSpeed.takeIf { it.isNotEmpty() && it != "Queued" && it != "--" }
      subText = (listOf("$clamped%") + listOfNotNull(cleanSpeed)).joinToString(" · ")
      contentTitle = fallbackTitle
      contentText = listOfNotNull(fallbackSubtitle, fallbackSize.takeIf { it.isNotEmpty() }).joinToString(" · ")
      style = NotificationCompat.BigTextStyle().bigText(contentText)
      progressValue = clamped
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setColor(0xFF1A73E8.toInt())
      .setContentTitle(contentTitle)
      .setContentText(contentText)
      .setSubText(subText)
      .setStyle(style)
      .setProgress(100, progressValue, progressValue <= 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setSound(null)
      .setVibrate(null)
      .setDefaults(0)
      .setShowWhen(false)
      .setContentIntent(pendingIntent)
      .addAction(android.R.drawable.ic_media_pause, "Pause All", pauseIntent)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  private fun stopServiceCleanly(expectedStartId: Int = -1) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      mainHandler.post { stopServiceCleanly(expectedStartId) }
      return
    }
    if (expectedStartId != -1 && expectedStartId != lastStartId) {
      return
    }
    clearDownloads()
    nativeOwnsQueue = false
    isRunning = false
    isInForeground = false
    instance = null
    MainActivity.serviceStartRequested = false
    MainActivity.releaseGlobalWakeLock()
    stopDiskPoller()
    releaseLocks()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    if (lastStartId != -1) {
      stopSelfResult(lastStartId)
    } else {
      stopSelf()
    }
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    // Keep Foreground Service alive if active or queued downloads are still running
    val hasActiveDisk = hasActiveDiskDownloads(this)
    if (!hasActiveDisk && (nativeOwnsQueue || snapshotDownloads().isEmpty())) {
      stopServiceCleanly(lastStartId)
    }
  }

  override fun onDestroy() {
    stopDiskPoller()
    releaseLocks()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
      (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(NOTIFICATION_ID)
    } catch (_: Exception) {}
    isRunning = false
    isInForeground = false
    instance = null
    MainActivity.serviceStartRequested = false
    MainActivity.releaseGlobalWakeLock()
    super.onDestroy()
  }
}
