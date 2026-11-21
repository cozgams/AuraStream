package com.aurastream.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Android Foreground Service for AuraStream background media downloads.
 * Ensures that CPU execution, network sockets, and high-performance Wi-Fi
 * remain active and immune to Android Doze mode or background killing.
 */
class AuraDownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  companion object {
    const val CHANNEL_ID = "aurastream_downloads"
    const val NOTIFICATION_ID = 9001
    const val ACTION_START = "com.aurastream.app.action.START_DOWNLOAD"
    const val ACTION_UPDATE = "com.aurastream.app.action.UPDATE_DOWNLOAD"
    const val ACTION_STOP = "com.aurastream.app.action.STOP_DOWNLOAD"

    const val EXTRA_TITLE = "extra_title"
    const val EXTRA_SUBTITLE = "extra_subtitle"
    const val EXTRA_PROGRESS = "extra_progress"
    const val EXTRA_SPEED = "extra_speed"
    const val EXTRA_SIZE = "extra_size"
    const val EXTRA_COUNT = "extra_count"

    var isRunning: Boolean = false
      private set
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    isRunning = true
    acquireLocks()
    createNotificationChannel()
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
        wakeLock?.acquire(3 * 60 * 60 * 1000L) // 3 hours safeguard for large series downloads
      }
    } catch (_: Exception) {}

    try {
      if (wifiLock == null) {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        @Suppress("DEPRECATION")
        wifiLock = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "AuraStream::DownloadWifiLock")?.apply {
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

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Offline Downloads",
        NotificationManager.IMPORTANCE_MIN
      ).apply {
        description = "Background progress for offline episodes"
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
      }
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      manager?.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action ?: ACTION_START
    when (action) {
      ACTION_STOP -> {
        stopServiceCleanly()
        return START_NOT_STICKY
      }
      ACTION_START, ACTION_UPDATE -> {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "AuraStream"
        val subtitle = intent?.getStringExtra(EXTRA_SUBTITLE) ?: "Downloading..."
        val progress = intent?.getIntExtra(EXTRA_PROGRESS, 0) ?: 0
        val speed = intent?.getStringExtra(EXTRA_SPEED) ?: ""
        val size = intent?.getStringExtra(EXTRA_SIZE) ?: ""
        val count = intent?.getIntExtra(EXTRA_COUNT, 1) ?: 1

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
          } catch (_: Exception) {}
        }
      }
    }
    return START_STICKY
  }

  private fun buildForegroundNotification(
    title: String,
    subtitle: String,
    progress: Int,
    speed: String,
    size: String,
    count: Int
  ): Notification {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    )

    val countPrefix = if (count > 1) "Downloading ($count) · " else "Downloading: "
    val details = if (size.isNotEmpty() && speed.isNotEmpty()) "$size · $speed" else if (size.isNotEmpty()) size else speed
    val text = if (details.isNotEmpty()) "$subtitle · $progress% ($details)" else "$subtitle · $progress%"

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("$countPrefix$title")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setProgress(100, progress, progress <= 0)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setContentIntent(pendingIntent)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)

    return builder.build()
  }

  private fun stopServiceCleanly() {
    isRunning = false
    releaseLocks()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  override fun onDestroy() {
    stopServiceCleanly()
    super.onDestroy()
  }
}
