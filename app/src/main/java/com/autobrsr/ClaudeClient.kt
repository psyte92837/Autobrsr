package com.autobrsr

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(val status: Int, message: String) : IOException(message)

/**
 * Минимальный клиент Messages API на HttpURLConnection (без сторонних библиотек).
 * https://platform.claude.com/docs/en/api/messages
 */
class ClaudeClient(private val apiKey: String) {

    fun createMessage(body: JSONObject): JSONObject {
        var attempt = 0
        while (true) {
            try {
                return post(body)
            } catch (e: ApiException) {
                // 429 / 5xx / 529 — временные, повторяем с паузой
                val retryable = e.status == 429 || e.status >= 500
                if (!retryable || attempt >= 3) throw e
            } catch (e: IOException) {
                if (attempt >= 3) throw e
            }
            attempt++
            Thread.sleep(2000L shl attempt)
        }
    }

    private fun post(body: JSONObject): JSONObject {
        val conn = URL(ENDPOINT).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 30_000
            conn.readTimeout = 600_000
            conn.setRequestProperty("content-type", "application/json")
            conn.setRequestProperty("x-api-key", apiKey)
            conn.setRequestProperty("anthropic-version", API_VERSION)
            conn.setRequestProperty("anthropic-beta", BETAS)
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val msg = runCatching { JSONObject(text).getJSONObject("error").getString("message") }.getOrDefault(text.take(300))
                val hint = when (code) {
                    401 -> " — проверьте ключ API в настройках"
                    403 -> " — у ключа нет доступа"
                    429 -> " — превышен лимит запросов"
                    else -> ""
                }
                throw ApiException(code, "API $code: $msg$hint")
            }
            return JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val ENDPOINT = "https://api.anthropic.com/v1/messages"
        const val API_VERSION = "2026-10-21"
        // Серверный запасной вариант: если модель откажется, запрос продолжит другая модель
        const val BETAS = "server-side-fallback-2026-07-01"
    }
}
