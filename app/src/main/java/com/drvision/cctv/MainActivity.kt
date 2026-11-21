package com.drvision.cctv

import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.system.Os
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var multicastLock: WifiManager.MulticastLock? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    companion object {
        private const val TAG = "V380"
        private const val PORT = 8777
        @Volatile private var nodeStarted = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)
        WebView.setWebContentsDebuggingEnabled(true)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        webView.webViewClient = WebViewClient()
        // Handle HTML5 fullscreen (element.requestFullscreen) — the default client ignores it.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) { callback.onCustomViewHidden(); return }
                customView = view
                customViewCallback = callback
                (window.decorView as FrameLayout).addView(
                    view,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                )
                webView.visibility = View.GONE
                applyImmersive(true)
            }
            override fun onHideCustomView() {
                val v = customView ?: return
                (window.decorView as FrameLayout).removeView(v)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
                applyImmersive(false)
            }
        }

        // Hold a multicast lock so UDP broadcast discovery works over the Wi-Fi hotspot.
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("v380-discovery").apply {
            setReferenceCounted(false)
            acquire()
        }
        Log.i(TAG, "multicast lock held=${multicastLock?.isHeld}")

        startNodeOnce()
        waitForServerThenLoad()
    }

    private fun startNodeOnce() {
        if (nodeStarted) return
        nodeStarted = true

        val nodeDir = File(filesDir, "nodejs-project")
        // Fresh copy each launch (project is small; picks up any bundled update).
        nodeDir.deleteRecursively()
        copyAsset("nodejs-project", nodeDir)

        val clipCache = File(cacheDir, "clipcache").apply { mkdirs() }
        try {
            Os.setenv("V380_CACHE", clipCache.absolutePath, true)
            Os.setenv("V380_LAN_PASS", "origin", true)
            Os.setenv("HOME", filesDir.absolutePath, true)
            Os.setenv("TMPDIR", cacheDir.absolutePath, true)
        } catch (e: Exception) {
            Log.e(TAG, "setenv failed", e)
        }

        val entry = File(nodeDir, "app/server.mjs").absolutePath
        Thread({
            Log.i(TAG, "Starting Node, entry=$entry")
            val code = try {
                NodeBridge.startNodeWithArguments(arrayOf("node", entry))
            } catch (t: Throwable) {
                Log.e(TAG, "Node start threw", t); -1
            }
            Log.w(TAG, "Node exited code=$code")
        }, "node-main").start()
    }

    private fun waitForServerThenLoad() {
        Thread({
            val probe = "http://127.0.0.1:$PORT/api/serverinfo"
            var ready = false
            for (i in 0 until 200) { // up to ~40s
                try {
                    val c = URL(probe).openConnection() as HttpURLConnection
                    c.connectTimeout = 600
                    c.readTimeout = 600
                    val code = c.responseCode
                    c.disconnect()
                    if (code in 200..599) { ready = true; break }
                } catch (_: Exception) { }
                Thread.sleep(200)
            }
            Log.i(TAG, "server ready=$ready")
            runOnUiThread {
                if (ready) webView.loadUrl("http://localhost:$PORT/")
                else webView.loadData(
                    "<html><body style='background:#111;color:#eee;font-family:sans-serif;padding:24px'>" +
                    "<h3>Node server did not come up on port $PORT.</h3>" +
                    "<p>Check logcat tag <b>NODEJS-MOBILE</b> / <b>V380</b>.</p></body></html>",
                    "text/html", "utf-8"
                )
            }
        }, "node-wait").start()
    }

    /** Recursively copy an assets subtree to a real directory Node can require() from. */
    private fun copyAsset(assetPath: String, outFile: File) {
        val children = try { assets.list(assetPath) } catch (_: Exception) { null }
        if (children.isNullOrEmpty()) {
            // leaf file
            try {
                assets.open(assetPath).use { input ->
                    outFile.parentFile?.mkdirs()
                    FileOutputStream(outFile).use { input.copyTo(it) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "copy file failed: $assetPath", e)
            }
            return
        }
        outFile.mkdirs()
        for (child in children) {
            copyAsset("$assetPath/$child", File(outFile, child))
        }
    }

    private fun applyImmersive(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController
            if (on) {
                c?.hide(WindowInsets.Type.systemBars())
                c?.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                c?.show(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (on)
                (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                 View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                 View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
            else View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        // Exit HTML5 fullscreen first (signals the page so its fullscreenchange fires and our view is torn down).
        if (customView != null) { (webView.webChromeClient as? WebChromeClient)?.onHideCustomView(); return }
        super.onBackPressed()
    }

    override fun onDestroy() {
        multicastLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
