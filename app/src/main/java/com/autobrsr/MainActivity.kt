package com.autobrsr

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.ListView
import android.widget.Spinner
import android.widget.Toast

/** Главный экран: список сценариев. */
class MainActivity : Activity() {
    private lateinit var store: ScenarioStore
    private lateinit var settings: Settings
    private lateinit var list: ListView
    private var items: List<Scenario> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ScenarioStore(this)
        settings = Settings(this)
        title = "Автобраузер"

        list = ListView(this)
        list.setOnItemClickListener { _, _, pos, _ -> openActions(items[pos]) }
        val empty = label("Сценариев пока нет.\nНажмите «＋ Новый», откройте сайт и говорите ИИ, куда нажимать — шаги запишутся.", 15f).pad(dp(24))
        list.emptyView = empty

        val root = vbox(
            hbox(
                button("＋ Новый") { newScenario() }.weight(1f),
                button("Импорт") { importDialog() }.weight(1f),
                button("⚙ Настройки") { settingsDialog() }.weight(1f),
            ),
            empty,
            list.weight(1f, vertical = true),
        ).pad(dp(8))
        setContentView(root)

        if (settings.apiKey.isEmpty()) settingsDialog()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        items = store.list()
        val titles = items.map { s ->
            val vars = s.variables.keys().asSequence().toList()
            "${s.name}\n${s.steps.length()} шагов" + (if (vars.isNotEmpty()) " · переменные: ${vars.joinToString()}" else "")
        }
        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, titles)
    }

    private fun openActions(s: Scenario) {
        val actions = arrayOf("▶ Запустить (без ИИ)", "✎ Дописать с ИИ", "Показать шаги", "Поделиться JSON", "Переименовать", "Удалить")
        AlertDialog.Builder(this).setTitle(s.name).setItems(actions) { _, which ->
            when (which) {
                0 -> startActivity(Intent(this, RunActivity::class.java).putExtra("name", s.name))
                1 -> startActivity(Intent(this, RecordActivity::class.java).putExtra("name", s.name).putExtra("continue", true))
                2 -> AlertDialog.Builder(this).setTitle(s.name)
                    .setMessage(("Старт: ${s.startUrl ?: "-"}\n\n") + s.stepList().mapIndexed { i, st -> Scenario.describeStep(st, i) }.joinToString("\n").ifEmpty { "(пусто)" })
                    .setPositiveButton("OK", null).show()
                3 -> startActivity(
                    Intent.createChooser(
                        Intent(Intent.ACTION_SEND).setType("application/json")
                            .putExtra(Intent.EXTRA_SUBJECT, "${s.name}.json")
                            .putExtra(Intent.EXTRA_TEXT, s.json.toString(2)),
                        "Поделиться сценарием",
                    )
                )
                4 -> {
                    val f = field("Новое имя", s.name)
                    AlertDialog.Builder(this).setTitle("Переименовать").setView(f.pad(dp(16)))
                        .setPositiveButton("OK") { _, _ ->
                            val n = f.text.toString().trim()
                            if (n.isNotEmpty() && n != s.name) {
                                store.delete(s.name); s.name = n; store.save(s); refresh()
                            }
                        }.setNegativeButton("Отмена", null).show()
                }
                5 -> AlertDialog.Builder(this).setTitle("Удалить «${s.name}»?")
                    .setPositiveButton("Удалить") { _, _ -> store.delete(s.name); refresh() }
                    .setNegativeButton("Отмена", null).show()
            }
        }.show()
    }

    private fun newScenario() {
        val name = field("Название, например «вход в почту»")
        val url = field("Адрес сайта, например google.com").apply { inputType = InputType.TYPE_TEXT_VARIATION_URI }
        AlertDialog.Builder(this).setTitle("Новый сценарий").setView(vbox(name, url).pad(dp(16)))
            .setPositiveButton("Начать запись") { _, _ ->
                val n = name.text.toString().trim().ifEmpty { "Сценарий ${items.size + 1}" }
                if (store.exists(n)) {
                    Toast.makeText(this, "Сценарий «$n» уже есть", Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }
                startActivity(
                    Intent(this, RecordActivity::class.java).putExtra("name", n).putExtra("url", url.text.toString().trim())
                )
            }.setNegativeButton("Отмена", null).show()
    }

    private fun importDialog() {
        val f = field("Вставьте JSON сценария").apply {
            setSingleLine(false); minLines = 6
        }
        AlertDialog.Builder(this).setTitle("Импорт сценария").setView(f.pad(dp(16)))
            .setPositiveButton("Импорт") { _, _ ->
                runCatching { store.import(f.text.toString()) }
                    .onSuccess { Toast.makeText(this, "Импортирован «${it.name}»", Toast.LENGTH_SHORT).show(); refresh() }
                    .onFailure { Toast.makeText(this, "Ошибка: ${it.message}", Toast.LENGTH_LONG).show() }
            }.setNegativeButton("Отмена", null).show()
    }

    private fun settingsDialog() {
        val key = field("Ключ API Anthropic (sk-ant-...)", settings.apiKey).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val model = field("Модель", settings.model)
        val effort = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, Settings.EFFORTS)
            setSelection(Settings.EFFORTS.indexOf(settings.effort).coerceAtLeast(0))
        }
        val vision = CheckBox(this).apply { text = "Отправлять ИИ скриншот страницы"; isChecked = settings.vision }
        val manual = CheckBox(this).apply { text = "Записывать и мои ручные нажатия"; isChecked = settings.recordManual }
        val desktop = CheckBox(this).apply { text = "Версия сайта для ПК"; isChecked = settings.desktopMode }
        AlertDialog.Builder(this).setTitle("Настройки")
            .setView(
                vbox(
                    label("Ключ нужен только для записи с ИИ. Запуск сценариев работает без него.", 13f),
                    key, label("Модель", 13f), model, label("Усилие ИИ (low — быстрее и дешевле)", 13f), effort,
                    vision, manual, desktop,
                ).pad(dp(16))
            )
            .setPositiveButton("Сохранить") { _, _ ->
                settings.apiKey = key.text.toString()
                settings.model = model.text.toString()
                settings.effort = effort.selectedItem as String
                settings.vision = vision.isChecked
                settings.recordManual = manual.isChecked
                settings.desktopMode = desktop.isChecked
            }.setNegativeButton("Отмена", null).show()
    }
}
