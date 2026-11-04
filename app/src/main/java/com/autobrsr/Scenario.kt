package com.autobrsr

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Сценарий — обычный JSON:
 * { name, startUrl, variables: {имя: значение}, steps: [ {action, target:{description, strategies}, ...} ] }
 */
class Scenario(val json: JSONObject) {
    var name: String
        get() = json.optString("name")
        set(v) { json.put("name", v) }
    var startUrl: String?
        get() = json.optString("startUrl").ifEmpty { null }
        set(v) { json.put("startUrl", v ?: JSONObject.NULL) }
    val variables: JSONObject get() = json.optJSONObject("variables") ?: JSONObject().also { json.put("variables", it) }
    val steps: JSONArray get() = json.optJSONArray("steps") ?: JSONArray().also { json.put("steps", it) }

    fun stepList(): List<JSONObject> = (0 until steps.length()).map { steps.getJSONObject(it) }

    @Synchronized fun addStep(step: JSONObject) { steps.put(step) }

    @Synchronized fun removeLast(): JSONObject? {
        if (steps.length() == 0) return null
        return steps.remove(steps.length() - 1) as JSONObject
    }

    @Synchronized fun lastStep(): JSONObject? = if (steps.length() == 0) null else steps.getJSONObject(steps.length() - 1)

    fun varsMap(): MutableMap<String, String> {
        val m = mutableMapOf<String, String>()
        for (k in variables.keys()) m[k] = variables.optString(k)
        return m
    }

    companion object {
        fun create(name: String, startUrl: String?) = Scenario(
            JSONObject()
                .put("name", name)
                .put("version", 1)
                .put("createdAt", System.currentTimeMillis())
                .put("startUrl", startUrl ?: JSONObject.NULL)
                .put("variables", JSONObject())
                .put("steps", JSONArray())
        )

        fun describeStep(step: JSONObject, i: Int): String {
            val sb = StringBuilder("${i + 1}. ")
            val action = step.optString("action")
            sb.append(ACTION_NAMES[action] ?: action)
            step.optJSONObject("target")?.optString("description")?.takeIf { it.isNotEmpty() }?.let { sb.append(" $it") }
            when (action) {
                "navigate" -> sb.append(" ").append(step.optString("url"))
                "press" -> sb.append(" ").append(step.optString("key"))
                "wait" -> sb.append(" ").append(step.optDouble("seconds", 1.0)).append(" с")
                "scroll" -> if (!step.has("target")) sb.append(if (step.optString("direction") == "up") " вверх" else " вниз")
                "check" -> sb.append(if (step.optBoolean("checked", true)) " ✓" else " ✗")
            }
            if (step.has("value")) sb.append(" = \"").append(step.optString("value")).append("\"")
            if (step.optBoolean("submit")) sb.append(" + Enter")
            return sb.toString()
        }

        private val ACTION_NAMES = mapOf(
            "navigate" to "открыть", "click" to "нажать", "type" to "ввести", "select" to "выбрать",
            "check" to "галочка", "press" to "клавиша", "scroll" to "прокрутить", "wait" to "ждать",
            "wait_for_text" to "ждать текст", "extract" to "прочитать", "hover" to "навести", "back" to "назад",
        )
    }
}

/** Хранит сценарии в папке приложения: files/scenarios/<имя>.json */
class ScenarioStore(context: Context) {
    private val dir = File(context.filesDir, "scenarios").apply { mkdirs() }

    private fun fileFor(name: String) = File(dir, name.replace(Regex("[^\\p{L}\\p{N}._ -]"), "_") + ".json")

    fun exists(name: String) = fileFor(name).exists()

    fun save(s: Scenario) {
        s.json.put("updatedAt", System.currentTimeMillis())
        fileFor(s.name).writeText(s.json.toString(2))
    }

    fun load(name: String): Scenario = Scenario(JSONObject(fileFor(name).readText()))

    fun delete(name: String) { fileFor(name).delete() }

    fun list(): List<Scenario> = (dir.listFiles { f -> f.name.endsWith(".json") } ?: emptyArray())
        .sortedByDescending { it.lastModified() }
        .mapNotNull { runCatching { Scenario(JSONObject(it.readText())) }.getOrNull() }

    fun import(text: String): Scenario {
        val s = Scenario(JSONObject(text))
        require(s.name.isNotBlank()) { "в JSON нет поля name" }
        s.steps // проверка, что steps есть или создастся
        save(s)
        return s
    }
}
