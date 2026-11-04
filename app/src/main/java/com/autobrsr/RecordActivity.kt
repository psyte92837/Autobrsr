package com.autobrsr

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.KeyEvent
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Запись сценария: сверху браузер, снизу чат с ИИ. Пользователь пишет или
 * говорит голосом, что сделать, ИИ выполняет — шаги записываются.
 * Ручные нажатия пользователя тоже записываются (если включено).
 */
class RecordActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var store: ScenarioStore
    private lateinit var scenario: Scenario
    private lateinit var webView: WebView
    private lateinit var driver: WebDriver
    private lateinit var runner: StepRunner
    private lateinit var log: LogView
    private lateinit var urlField: EditText
    private lateinit var input: EditText
    private lateinit var sendBtn: Button
    private var agent: Agent? = null
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        settings = Settings(this)
        store = ScenarioStore(this)

        val name = intent.getStringExtra("name") ?: "Сценарий"
        val cont = intent.getBooleanExtra("continue", false)
        val startUrl = intent.getStringExtra("url")?.takeIf { it.isNotBlank() }?.let { Agent.normalizeUrl(it) }
        scenario = if (cont && store.exists(name)) store.load(name) else Scenario.create(name, startUrl)
        title = "● Запись: $name"

        buildUi()
        driver = WebDriver(webView, assets.open("autobrsr.js").bufferedReader().use { it.readText() }, settings.desktopMode)
        driver.onUrlChanged = { u -> runOnUiThread { if (!urlField.hasFocus()) urlField.setText(u) } }
        runner = StepRunner(driver, log::add)
        if (settings.recordManual) webView.addJavascriptInterface(Bridge(), "AB")

        if (settings.apiKey.isEmpty()) log.add("⚠ Ключ API не задан (⚙ Настройки на главном экране). Можно записывать только вручную.")
        else agent = Agent(settings, driver, runner, scenario, log::add)

        log.add("Скажите или напишите, что сделать. Например: «нажми Войти», «введи в поиск котики и нажми Enter».")
        if (cont && scenario.steps.length() > 0) {
            background {
                log.add("↻ Воспроизвожу записанные шаги…")
                runner.play(scenario)
                log.add("Продолжайте — новые шаги допишутся в конец.")
            }
        } else if (scenario.startUrl != null) {
            background { driver.loadUrl(scenario.startUrl!!) }
        }
    }

    private fun buildUi() {
        webView = WebView(this)
        log = LogView(this)
        urlField = field("Адрес сайта").apply {
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_GO) { go(); true } else false }
        }
        input = field("Что сделать? Например: нажми «Войти»").apply {
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, id, ev ->
                if (id == EditorInfo.IME_ACTION_SEND || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { send(); true } else false
            }
        }
        sendBtn = button("➤") { send() }
        val root = vbox(
            hbox(urlField.weight(1f), button("→") { go() }),
            webView.weight(3f, vertical = true),
            log.view.pad(dp(4)).weight(1.3f, vertical = true),
            hbox(input.weight(1f), button("🎤") { voice() }, sendBtn),
            hbox(
                button("Шаги") { showSteps() }.weight(1f),
                button("↶ Отменить") { undo() }.weight(1f),
                button("▶ Проверить") { replay() }.weight(1f),
                button("💾") { save(); Toast.makeText(this, "Сохранено", Toast.LENGTH_SHORT).show() },
            ),
        )
        setContentView(root)
    }

    private fun background(task: () -> Unit) {
        worker.execute {
            busy = true
            runOnUiThread { sendBtn.isEnabled = false }
            try {
                task()
            } catch (e: StoppedException) {
                log.add("■ Остановлено")
            } catch (e: Exception) {
                log.add("✘ ${e.message}")
            } finally {
                busy = false
                runOnUiThread { sendBtn.isEnabled = true }
            }
        }
    }

    private fun go() {
        val url = Agent.normalizeUrl(urlField.text.toString())
        urlField.clearFocus()
        val step = JSONObject().put("action", "navigate").put("url", url)
        if (scenario.startUrl == null && scenario.steps.length() == 0) scenario.startUrl = url else scenario.addStep(step)
        log.add("   ✔ открыть $url")
        background { driver.loadUrl(url) }
    }

    private fun send() {
        val text = input.text.toString().trim()
        if (text.isEmpty() || busy) return
        val a = agent ?: return log.add("⚠ Задайте ключ API в настройках")
        input.setText("")
        log.add("\n🗣 $text")
        background { a.command(text) }
    }

    private fun voice() {
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Что сделать на странице?")
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(i, REQ_VOICE)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "Голосовой ввод недоступен на этом устройстве", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_VOICE && resultCode == RESULT_OK) {
            val text = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: return
            input.setText(text)
            send()
        }
    }

    private fun showSteps() {
        val text = scenario.stepList().mapIndexed { i, s -> Scenario.describeStep(s, i) }.joinToString("\n")
        AlertDialog.Builder(this).setTitle("Шаги (${scenario.steps.length()})")
            .setMessage("Старт: ${scenario.startUrl ?: "-"}\n\n" + text.ifEmpty { "(пусто)" })
            .setPositiveButton("OK", null).show()
    }

    private fun undo() {
        val s = scenario.removeLast()
        log.add(if (s != null) "↶ удалён шаг: ${Scenario.describeStep(s, scenario.steps.length())} (в браузере ничего не откатывается)" else "Нечего удалять")
    }

    private fun replay() {
        if (busy) return
        log.add("\n▶ Проверка сценария без ИИ…")
        background { runner.play(scenario) }
    }

    private fun save() = store.save(scenario)

    /** Ручные действия пользователя на странице (приходят из autobrsr.js). */
    inner class Bridge {
        @JavascriptInterface
        fun onUserAction(json: String) {
            if (busy) return // во время работы ИИ ручные касания не записываем
            val e = runCatching { JSONObject(json) }.getOrNull() ?: return
            val target = JSONObject().put("description", e.optString("description")).put("strategies", e.getJSONArray("strategies"))
            val step = JSONObject().put("action", e.optString("kind")).put("target", target)
            when (e.optString("kind")) {
                "type" -> {
                    var value = e.optString("value")
                    if (e.optBoolean("password")) {
                        scenario.variables.put("password", value)
                        value = "{{password}}"
                    }
                    step.put("value", value).put("submit", e.optBoolean("submit"))
                    // Повторное событие того же поля (Enter + change) — обновляем последний шаг
                    val last = scenario.lastStep()
                    if (last != null && last.optString("action") == "type" &&
                        last.optJSONObject("target")?.optJSONArray("strategies")?.toString() == target.getJSONArray("strategies").toString()
                    ) {
                        last.put("value", value).put("submit", last.optBoolean("submit") || e.optBoolean("submit"))
                        return
                    }
                }
                "select" -> step.put("value", e.optString("value"))
                "check" -> step.put("checked", e.optBoolean("checked"))
            }
            scenario.addStep(step)
            log.add("   ✋ ${Scenario.describeStep(step, scenario.steps.length() - 1)}")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            AlertDialog.Builder(this).setTitle("Что сделать?")
                .setItems(arrayOf("Назад на странице (записать шаг)", "Сохранить и выйти")) { _, w ->
                    if (w == 0) {
                        scenario.addStep(JSONObject().put("action", "back"))
                        log.add("   ✔ назад")
                        webView.goBack()
                    } else finish()
                }.show()
        } else finish()
    }

    override fun onPause() {
        super.onPause()
        save()
    }

    override fun onDestroy() {
        driver.stopped = true
        worker.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val REQ_VOICE = 42
    }
}
