package com.autobrsr

import android.os.SystemClock
import android.view.KeyEvent
import org.json.JSONObject

/**
 * Выполняет шаги сценария. Используется и при записи (элемент уже известен —
 * presetRef), и при запуске без ИИ (элемент ищется по записанным селекторам).
 */
class StepRunner(private val d: WebDriver, private val log: (String) -> Unit) {

    fun substitute(v: String, vars: Map<String, String>): String =
        Regex("\\{\\{\\s*(\\w+)\\s*\\}\\}").replace(v) { m -> vars[m.groupValues[1]] ?: m.value }

    /** Ищет элемент по стратегиям, пока не истечёт таймаут. Возвращает ссылку на элемент. */
    fun resolve(step: JSONObject, timeoutMs: Long): Int {
        val target = step.optJSONObject("target") ?: throw RuntimeException("у шага нет элемента")
        val strategies = target.optJSONArray("strategies")?.toString() ?: "[]"
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val r = runCatching { d.call("resolve(${WebDriver.q(strategies)})") }.getOrNull()
            if (r != null && r.has("ref")) return r.getInt("ref")
            if (SystemClock.uptimeMillis() > end) {
                throw RuntimeException("не найден элемент: ${target.optString("description").ifEmpty { strategies }}")
            }
            d.sleep(300)
        }
    }

    private fun check(r: JSONObject) {
        r.optString("error").takeIf { it.isNotEmpty() }?.let { throw RuntimeException(it) }
    }

    /** Выполняет шаг. Возвращает результат (для extract) или null. */
    fun perform(step: JSONObject, vars: MutableMap<String, String>, timeoutMs: Long = 10_000, presetRef: Int? = null): String? {
        val ref = { presetRef ?: resolve(step, timeoutMs) }
        val value = substitute(step.optString("value"), vars)
        var result: String? = null
        when (val action = step.optString("action")) {
            "navigate" -> d.loadUrl(substitute(step.optString("url"), vars))
            "back" -> d.goBack()
            "click" -> d.tap(ref())
            "hover" -> check(d.call("hover(${ref()})"))
            "type" -> {
                val r = ref()
                check(d.call("type($r, ${WebDriver.q(value)}, ${step.optBoolean("clear", true)})"))
                if (step.optBoolean("submit")) {
                    d.call("focus($r)")
                    d.call("suppress(1500)")
                    check(d.call("submit($r)"))
                }
            }
            "select" -> check(d.call("select(${ref()}, ${WebDriver.q(value)})"))
            "check" -> {
                val r = ref()
                val want = step.optBoolean("checked", true)
                val st = d.call("isChecked($r)")
                check(st)
                if (st.optBoolean("checked") != want) d.tap(r)
            }
            "press" -> {
                val key = step.optString("key")
                val code = KEYS[key.lowercase()]
                if (code != null) d.nativeKey(code) else d.call("key(${WebDriver.q(key)})")
            }
            "scroll" -> if (step.has("target")) d.call("point(${ref()})") else d.call("scroll(${WebDriver.q(step.optString("direction", "down"))})")
            "wait" -> d.sleep((step.optDouble("seconds", 1.0) * 1000).toLong())
            "wait_for_text" -> {
                val end = SystemClock.uptimeMillis() + maxOf(timeoutMs, (step.optDouble("seconds", 0.0) * 1000).toLong())
                while (!d.call("hasText(${WebDriver.q(value)})").optBoolean("found")) {
                    if (SystemClock.uptimeMillis() > end) throw RuntimeException("не появился текст «$value»")
                    d.sleep(300)
                }
            }
            "extract" -> {
                val r = if (step.has("target")) d.call("text(${ref()})") else d.call("text(null)")
                check(r)
                result = r.optString("text")
                log("  ⇒ ${step.optString("save_as").ifEmpty { "текст" }}: ${result.take(500)}")
                step.optString("save_as").takeIf { it.isNotEmpty() }?.let { vars[it] = result }
            }
            else -> throw RuntimeException("неизвестное действие: $action")
        }
        if (step.optString("action") !in setOf("wait", "extract", "hover", "wait_for_text", "navigate", "back")) d.waitForLoad(8_000)
        return result
    }

    /** Запуск всего сценария без ИИ. */
    fun play(s: Scenario, overrides: Map<String, String> = emptyMap(), timeoutMs: Long = 10_000) {
        val vars = s.varsMap().apply { putAll(overrides) }
        val started = SystemClock.uptimeMillis()
        s.startUrl?.let {
            log("→ открываю $it")
            d.loadUrl(substitute(it, vars))
        }
        s.stepList().forEachIndexed { i, step ->
            log(Scenario.describeStep(step, i))
            try {
                perform(step, vars, timeoutMs)
            } catch (e: StoppedException) {
                throw e
            } catch (e: Exception) {
                throw RuntimeException("Шаг ${i + 1} не выполнен: ${e.message}", e)
            }
        }
        val sec = (SystemClock.uptimeMillis() - started) / 1000.0
        log("✅ Готово: ${s.steps.length()} шагов за ${"%.1f".format(sec)} с")
    }

    companion object {
        val KEYS = mapOf(
            "enter" to KeyEvent.KEYCODE_ENTER, "tab" to KeyEvent.KEYCODE_TAB, "escape" to KeyEvent.KEYCODE_ESCAPE,
            "esc" to KeyEvent.KEYCODE_ESCAPE, "backspace" to KeyEvent.KEYCODE_DEL, "delete" to KeyEvent.KEYCODE_FORWARD_DEL,
            "arrowup" to KeyEvent.KEYCODE_DPAD_UP, "arrowdown" to KeyEvent.KEYCODE_DPAD_DOWN,
            "arrowleft" to KeyEvent.KEYCODE_DPAD_LEFT, "arrowright" to KeyEvent.KEYCODE_DPAD_RIGHT,
            "pagedown" to KeyEvent.KEYCODE_PAGE_DOWN, "pageup" to KeyEvent.KEYCODE_PAGE_UP, "space" to KeyEvent.KEYCODE_SPACE,
        )
    }
}
