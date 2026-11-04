package com.autobrsr

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText

/** Запуск записанного сценария БЕЗ ИИ. */
class RunActivity : Activity() {
    private lateinit var scenario: Scenario
    private lateinit var webView: WebView
    private lateinit var driver: WebDriver
    private lateinit var runner: StepRunner
    private lateinit var log: LogView
    private lateinit var runBtn: Button
    private var thread: Thread? = null
    private var lastVars: Map<String, String> = emptyMap()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scenario = ScenarioStore(this).load(intent.getStringExtra("name") ?: return finish())
        title = "▶ ${scenario.name}"
        webView = WebView(this)
        log = LogView(this)
        runBtn = button("▶ Запустить") { askVarsAndRun() }
        setContentView(
            vbox(
                webView.weight(3f, vertical = true),
                log.view.pad(dp(4)).weight(1f, vertical = true),
                hbox(runBtn.weight(1f), button("■ Стоп") { stop() }.weight(1f), button("Закрыть") { finish() }.weight(1f)),
            )
        )
        driver = WebDriver(webView, assets.open("autobrsr.js").bufferedReader().use { it.readText() }, Settings(this).desktopMode)
        runner = StepRunner(driver, log::add)
        askVarsAndRun()
    }

    /** Если в сценарии есть переменные — спрашиваем значения (по умолчанию — записанные). */
    private fun askVarsAndRun() {
        if (thread?.isAlive == true) return
        val vars = scenario.varsMap()
        if (vars.isEmpty()) return start(emptyMap())
        val fields = vars.mapValues { (k, v) -> field(k, lastVars[k] ?: v) }
        val box = vbox().pad(dp(16))
        fields.forEach { (k, f) -> box.addView(label(k, 13f)); box.addView(f) }
        AlertDialog.Builder(this).setTitle("Значения переменных").setView(box)
            .setPositiveButton("Запустить") { _, _ -> start(fields.mapValues { (_, f: EditText) -> f.text.toString() }) }
            .setNegativeButton("Отмена", null).show()
    }

    private fun start(vars: Map<String, String>) {
        lastVars = vars
        log.clear()
        driver.stopped = false
        runBtn.isEnabled = false
        thread = Thread {
            try {
                runner.play(scenario, vars)
            } catch (e: StoppedException) {
                log.add("■ Остановлено")
            } catch (e: Exception) {
                log.add("❌ ${e.message}")
            } finally {
                runOnUiThread { runBtn.isEnabled = true; runBtn.text = "▶ Ещё раз" }
            }
        }.apply { start() }
    }

    private fun stop() {
        driver.stopped = true
    }

    override fun onDestroy() {
        driver.stopped = true
        webView.destroy()
        super.onDestroy()
    }
}
