package com.autobrsr

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

// Небольшие помощники для сборки интерфейса кодом (без XML-разметки).

fun Context.dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

fun Context.vbox(vararg children: View) = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    children.forEach { addView(it) }
}

fun Context.hbox(vararg children: View) = LinearLayout(this).apply {
    orientation = LinearLayout.HORIZONTAL
    children.forEach { addView(it) }
}

fun Context.button(text: String, onClick: (View) -> Unit) = Button(this).apply {
    this.text = text
    isAllCaps = false
    setOnClickListener(onClick)
}

fun Context.field(hint: String, value: String = "") = EditText(this).apply {
    this.hint = hint
    setText(value)
    setSingleLine(true)
}

fun Context.label(text: String, sizeSp: Float = 14f, bold: Boolean = false) = TextView(this).apply {
    this.text = text
    textSize = sizeSp
    if (bold) setTypeface(typeface, Typeface.BOLD)
}

fun <T : View> T.weight(w: Float, vertical: Boolean = false): T {
    layoutParams = if (vertical) LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, w)
    else LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, w)
    return this
}

fun <T : View> T.pad(px: Int): T { setPadding(px, px, px, px); return this }

/** Прокручиваемый журнал событий. */
class LogView(private val activity: Activity) {
    val text = TextView(activity).apply {
        textSize = 12f
        setTextIsSelectable(true)
        typeface = Typeface.MONOSPACE
    }
    val view = ScrollView(activity).apply { addView(text) }

    fun add(line: String) = activity.runOnUiThread {
        text.append(if (text.length() == 0) line else "\n$line")
        view.post { view.fullScroll(View.FOCUS_DOWN) }
    }

    fun clear() = activity.runOnUiThread { text.text = "" }
}
