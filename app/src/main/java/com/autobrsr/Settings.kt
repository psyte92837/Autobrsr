package com.autobrsr

import android.content.Context

/** Настройки приложения (ключ API, модель и т.д.). */
class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var apiKey: String
        get() = prefs.getString("api_key", "") ?: ""
        set(v) = prefs.edit().putString("api_key", v.trim()).apply()
    var model: String
        get() = prefs.getString("model", DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(v) = prefs.edit().putString("model", v.trim().ifEmpty { DEFAULT_MODEL }).apply()
    var effort: String
        get() = prefs.getString("effort", "medium") ?: "medium"
        set(v) = prefs.edit().putString("effort", v).apply()
    var vision: Boolean
        get() = prefs.getBoolean("vision", true)
        set(v) = prefs.edit().putBoolean("vision", v).apply()
    var recordManual: Boolean
        get() = prefs.getBoolean("record_manual", true)
        set(v) = prefs.edit().putBoolean("record_manual", v).apply()
    var desktopMode: Boolean
        get() = prefs.getBoolean("desktop_mode", false)
        set(v) = prefs.edit().putBoolean("desktop_mode", v).apply()

    companion object {
        const val DEFAULT_MODEL = "claude-opus-5-5"
        val EFFORTS = listOf("low", "medium", "high")
    }
}
