# MC Launcher — сайт

Статический сайт для GitHub Pages: `index.html`, `style.css`, `app.js`, картинки и видео в `assets/`.

Установщик лежит не здесь, а в GitHub Releases этого репозитория. Кнопки «Скачать» ведут на
`releases/latest/download/MCLauncher-Setup.exe`, поэтому для новой версии достаточно создать релиз
(тег вида `v2.1.13`) и приложить файл установщика с именем **MCLauncher-Setup.exe**, а в `release.json`
вписать новую версию и размер файла в байтах — их сайт показывает у кнопок.
