package com.autobrsr

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.KeyEvent
import android.view.MotionEvent
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class StoppedException : RuntimeException("Остановлено")

/**
 * Управляет WebView из фонового потока: выполнение JS, касания, клавиши,
 * ожидание загрузки, скриншоты. Все методы блокирующие — не вызывать с главного потока.
 */
class WebDriver(val webView: WebView, private val helperJs: String, desktopMode: Boolean = false) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile var loading = false
        private set
    @Volatile var stopped = false
    var onUrlChanged: ((String) -> Unit)? = null

    init {
        configure(desktopMode)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(desktopMode: Boolean) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(false) // ссылки target=_blank открываются в том же окне
            if (desktopMode) {
                userAgentString = userAgentString.replace("Mobile", "").replace("Android", "X11; Linux")
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                loading = true
                onUrlChanged?.invoke(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                loading = false
                onUrlChanged?.invoke(url)
                view.evaluateJavascript(helperJs, null) // включает запись ручных действий
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val scheme = request.url.scheme ?: return true
                return scheme != "http" && scheme != "https" // tel:, intent: и т.п. игнорируем
            }
        }
    }

    // ---------- потоки ----------

    fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val result = AtomicReference<Result<T>>()
        val latch = CountDownLatch(1)
        main.post {
            result.set(runCatching(block))
            latch.countDown()
        }
        if (!latch.await(30, TimeUnit.SECONDS)) throw RuntimeException("UI-поток не отвечает")
        return result.get().getOrThrow()
    }

    fun sleep(ms: Long) {
        val end = SystemClock.uptimeMillis() + ms
        while (SystemClock.uptimeMillis() < end) {
            if (stopped) throw StoppedException()
            Thread.sleep(minOf(100L, end - SystemClock.uptimeMillis()).coerceAtLeast(1))
        }
        if (stopped) throw StoppedException()
    }

    private fun evalRaw(js: String, timeoutSec: Long = 20): String {
        if (stopped) throw StoppedException()
        val result = AtomicReference<String>("null")
        val latch = CountDownLatch(1)
        main.post {
            webView.evaluateJavascript(js) { v ->
                result.set(v ?: "null")
                latch.countDown()
            }
        }
        if (!latch.await(timeoutSec, TimeUnit.SECONDS)) throw RuntimeException("страница не отвечает на JavaScript")
        return result.get()
    }

    /** Вызывает window.__ab.<expr>, предварительно внедрив помощника. */
    fun call(expr: String): JSONObject {
        val raw = evalRaw("$helperJs\n;window.__ab.$expr")
        val v = JSONTokener(raw).nextValue()
        return when (v) {
            is String -> JSONObject(v)
            is JSONObject -> v
            else -> JSONObject().put("error", "пустой ответ страницы (страница ещё грузится?)")
        }
    }

    // ---------- навигация ----------

    fun loadUrl(url: String) {
        onMain { webView.loadUrl(url) }
        loading = true
        waitForLoad(30_000)
    }

    fun goBack() {
        onMain { if (webView.canGoBack()) webView.goBack() }
        waitForLoad()
    }

    fun currentUrl(): String = onMain { webView.url ?: "" }

    fun waitForLoad(timeoutMs: Long = 10_000) {
        sleep(300) // навигация после клика начинается не мгновенно
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < end) {
            val ready = runCatching { call("ready()").optString("state") }.getOrDefault("")
            if (!loading && ready == "complete") break
            sleep(200)
        }
        sleep(400) // дать скриптам страницы дорисовать
    }

    // ---------- ввод ----------

    /** Нативное касание по центру элемента (как настоящий палец). */
    fun tap(ref: Int) {
        call("suppress(2000)")
        val p = call("point($ref)")
        p.optString("error").takeIf { it.isNotEmpty() }?.let { throw RuntimeException(it) }
        sleep(150) // прокрутка
        val p2 = call("point($ref)")
        if (!p2.optBoolean("hittable")) {
            call("jsClick($ref)") // элемент перекрыт — кликаем через JS
            return
        }
        val dpr = p2.optDouble("dpr", 1.0)
        val x = (p2.optDouble("x") * dpr).toFloat()
        val y = (p2.optDouble("y") * dpr).toFloat()
        onMain {
            val t = SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0)
            val up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0)
            webView.dispatchTouchEvent(down)
            webView.dispatchTouchEvent(up)
            down.recycle(); up.recycle()
        }
    }

    fun nativeKey(keyCode: Int) {
        call("suppress(1500)")
        onMain {
            webView.requestFocus()
            webView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
            webView.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, keyCode))
        }
    }

    fun screenshotBase64(maxWidth: Int = 800): String? = runCatching {
        onMain {
            val w = webView.width
            val h = webView.height
            if (w == 0 || h == 0) return@onMain null
            val scale = minOf(1f, maxWidth.toFloat() / w)
            val bmp = Bitmap.createBitmap((w * scale).toInt(), (h * scale).toInt(), Bitmap.Config.RGB_565)
            val c = Canvas(bmp)
            c.scale(scale, scale)
            c.translate(-webView.scrollX.toFloat(), -webView.scrollY.toFloat())
            webView.draw(c)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 60, out)
            bmp.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    }.getOrNull()

    /** Текстовый снимок страницы для ИИ. */
    fun snapshotText(limit: Int = 200, textChars: Int = 3000): String {
        val s = call("snapshot($limit, $textChars)")
        val els = s.optJSONArray("elements") ?: JSONArray()
        val lines = (0 until els.length()).joinToString("\n") { els.getString(it) }
        return buildString {
            append("URL: ").append(s.optString("url")).append('\n')
            append("Заголовок: ").append(s.optString("title")).append("\n\n")
            append("Интерактивные элементы (используй номер в element_id):\n")
            append(lines.ifEmpty { "(нет)" }).append("\n\n")
            append("Видимый текст страницы (обрезан):\n").append(s.optString("text"))
        }
    }

    companion object {
        fun q(s: String): String = JSONObject.quote(s)
    }
}
