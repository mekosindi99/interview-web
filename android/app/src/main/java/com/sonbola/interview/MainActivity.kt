package com.sonbola.interview

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

// Thin WebView shell around the live site (see strings.xml#site_url) — the
// actual app is the website; everything here exists only to make things a
// plain <webview> tag can't do on its own: ask for the mic permission the
// speaking-question recorder needs, let the CV/material file inputs open a
// real file/camera chooser, and keep external links (nothing in this app
// today, but future-proof) from hijacking the whole app into a browser tab.
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var offlineView: View

    // getUserMedia() (speaking-question recording) surfaces here as an
    // Android PermissionRequest — but only once the OS-level RECORD_AUDIO
    // permission is already granted; if it isn't, the request is stashed
    // here while the system permission dialog is shown, then resolved from
    // the launcher callback below instead of being denied outright.
    private var pendingPermissionRequest: PermissionRequest? = null

    // <input type="file"> (CV upload, admin material/listening-audio
    // upload, question images) surfaces here — resolved once the system
    // file/camera picker returns.
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraUri: Uri? = null

    private val requestMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingPermissionRequest
        pendingPermissionRequest = null
        if (request == null) return@registerForActivityResult
        if (granted) {
            request.grant(request.resources)
        } else {
            request.deny()
        }
    }

    private val requestCameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null
        if (callback == null) return@registerForActivityResult
        val data = result.data
        val uris: Array<Uri>? = when {
            result.resultCode != RESULT_OK -> null
            data?.clipData != null -> Array(data.clipData!!.itemCount) { i -> data.clipData!!.getItemAt(i).uri }
            data?.data != null -> arrayOf(data.data!!)
            pendingCameraUri != null -> arrayOf(pendingCameraUri!!)
            else -> null
        }
        callback.onReceiveValue(uris)
        pendingCameraUri = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        progress = findViewById(R.id.progress)
        offlineView = findViewById(R.id.offline_view)

        // Android 15+ (targetSdk 35) draws app content edge-to-edge behind
        // the status/navigation bars by default — without this, the page's
        // own top bar (theme toggle, language row) rendered right under the
        // status bar with no clearance and looked visually "stuck"/clipped
        // at the top. Insetting the root view by the system bars' size
        // pushes the WebView down/up to start clear of both bars instead.
        val root = findViewById<FrameLayout>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        findViewById<Button>(R.id.retry_btn).setOnClickListener { loadSiteIfOnline() }

        setupWebView()
        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack() else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }

        loadSiteIfOnline()
    }

    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // Firebase Auth session persistence and the exam's own local
        // answer-progress cache both rely on IndexedDB, which needs DOM
        // storage above but also (on some WebView versions) this explicit
        // flag to actually persist across app restarts.
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(false)
        settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val host = url.host ?: ""
                // Everything the site itself needs stays inside the WebView
                // (the main domain, Firebase's own auth/firestore hosts,
                // and the admin server on Render) — anything else (a
                // candidate tapping a stray mailto:/tel: link, say) opens in
                // a real app instead of dead-ending inside this WebView.
                val staysInApp = host.endsWith("sonbola.shop") ||
                    host.endsWith("firebaseapp.com") ||
                    host.endsWith("googleapis.com") ||
                    host.endsWith("google.com") ||
                    host.endsWith("gstatic.com") ||
                    host.endsWith("onrender.com")
                if (staysInApp) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: Exception) {
                    false
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wantsAudio = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                if (!wantsAudio) {
                    // Only ever grants microphone capture — no camera/video
                    // stream, no protected media, nothing else this site
                    // doesn't itself use.
                    request.deny()
                    return
                }
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(request.resources)
                } else {
                    pendingPermissionRequest = request
                    requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback

                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                    != PackageManager.PERMISSION_GRANTED
                ) {
                    requestCameraPermission.launch(Manifest.permission.CAMERA)
                }

                val intent = fileChooserParams.createIntent()
                // createIntent() alone opens a document/gallery picker but
                // drops the "take a photo" option — chaining it as an
                // EXTRA_INITIAL_INTENTS alongside a real camera intent is
                // what makes the system chooser offer both.
                val chooserIntent = try {
                    val photoFile = File.createTempFile("capture_", ".jpg", cacheDir)
                    val photoUri = FileProvider.getUriForFile(
                        this@MainActivity, "com.sonbola.interview.fileprovider", photoFile
                    )
                    pendingCameraUri = photoUri
                    val cameraIntent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).apply {
                        putExtra(android.provider.MediaStore.EXTRA_OUTPUT, photoUri)
                        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    }
                    Intent.createChooser(intent, null).apply {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
                    }
                } catch (e: Exception) {
                    intent
                }
                fileChooserLauncher.launch(chooserIntent)
                return true
            }
        }
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun loadSiteIfOnline() {
        if (isOnline()) {
            offlineView.visibility = View.GONE
            progress.visibility = View.VISIBLE
            webView.loadUrl(getString(R.string.site_url))
        } else {
            offlineView.visibility = View.VISIBLE
            progress.visibility = View.GONE
        }
    }
}
