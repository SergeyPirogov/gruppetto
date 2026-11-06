# Модель велосипедиста для 3D-графіки

Покладіть сюди файл **`rider.fbx`** (наприклад, прямо з Mixamo) або **`rider.glb`** — будь-якого персонажа людини
зі скелетом (rigged humanoid). Конвертувати нічого не треба.
Power Up сам розверне його по ходу руху, підбере розмір, посадить на велосипед, покладе руки на кермо,
нахилить корпус і крутитиме ногами педалі в такт каденсу. Якщо файлу немає — використовується вбудований велосипедист.

Перевірено на скелетах Mixamo (`mixamorig:LeftUpLeg / LeftLeg / LeftFoot`) і KayKit (`upperleg.l / lowerleg.l`);
також розпізнаються назви Blender/Rigify (`thigh.L / shin.L`) і Unity Humanoid (`LeftUpperLeg / LeftLowerLeg`).
Якщо в моделі є анімація педалювання (назва кліпу містить cycle / bike / pedal / ride), програється вона.

## Де взяти модель

**Sketchfab** — https://sketchfab.com/search?features=downloadable&type=models&q=rigged+character
Фільтри: *Downloadable*, ліцензія *CC Attribution* або *CC0*. Кнопка Download → **glTF / GLB**. Обирайте моделі з
позначкою *Rigged*. Атрибуцію автора запишіть у `assets/CREDITS.md`.

**Mixamo** (безкоштовно з акаунтом Adobe) — https://www.mixamo.com → Characters → оберіть персонажа →
Download: *FBX Binary (.fbx)*, *T-Pose* → перейменуйте файл на `rider.fbx` і покладіть сюди. Текстури вже всередині.
Умови Mixamo дозволяють використовувати персонажів у своїх проєктах, але не поширювати самі файли моделей —
тому `rider.fbx` і `rider.glb` додано в `.gitignore` (для моделі з CC0 можна закомітити: `git add -f`).

## Тонке налаштування (необов’язково) — `rider.json`

```json
{
  "height": 1.75,
  "rotateY": 90,
  "jerseyMaterials": ["Shirt"],
  "shortsMaterials": ["Pants"]
}
```

- `height` — зріст у метрах (за замовчуванням 1.75);
- `rotateY` — поворот у градусах, якщо автоматика розвернула персонажа неправильно;
- `jerseyMaterials` / `shortsMaterials` — назви матеріалів одягу, які перефарбувати в кольори джерсі й шортів
  (без цього матеріали з назвами на кшталт *shirt / top* і *pants / shorts* перефарбовуються автоматично).
