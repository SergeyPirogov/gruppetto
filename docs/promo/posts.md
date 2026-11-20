# Gruppetto: перші користувачі

Медіа:
- `still-pack-16x9.png`, `still-arch-9x16.png`, `still-climb-9x16.png` — стоп-кадри, у цій папці.
- Відео не в git, бо важкі: `.local/promo/gruppetto-race-h.mp4` (32 с, 16:9, для Telegram, Facebook, YouTube, Reddit) і `.local/promo/gruppetto-race-v.mp4` (32 с, 9:16, для Reels, Shorts, TikTok, Stories). Записати знову: `node tools/promo_video.mjs carpathians 1280x720` (і `720x1280`), порізати ffmpeg за підказкою в скрипті.

У відео симулятор на 300 Вт, гонка з ботами на «Карпатському серпантині».

## Посилання під кожен канал

Українська адреса `/uk/` запрацює після деплою PR #189. До того бери `https://automation-remarks.com/gruppetto/?utm_campaign=…`.

| Куди | Посилання |
|---|---|
| Telegram-чати велосипедистів | https://automation-remarks.com/gruppetto/uk/?utm_campaign=tg-chats |
| Повідомлення клубам | https://automation-remarks.com/gruppetto/uk/?utm_campaign=tg-clubs |
| Facebook-групи | https://automation-remarks.com/gruppetto/uk/?utm_campaign=fb-groups |
| Instagram, Reels, Stories | https://automation-remarks.com/gruppetto/uk/?utm_campaign=instagram |
| Strava-клуби | https://automation-remarks.com/gruppetto/uk/?utm_campaign=strava-club |
| Reddit | https://automation-remarks.com/gruppetto/?utm_campaign=reddit |
| Форум intervals.icu | https://automation-remarks.com/gruppetto/?utm_campaign=intervals-forum |

Одному клубу чи чату можна дати своє ім'я кампанії, наприклад `tg-club-kyiv-roadies`. Результат видно в GoatCounter у блоці Campaigns.

---

## 1. Telegram-чат велосипедистів (коротко, з відео 16:9)

> Зробив безкоштовний віртуальний велотренажер — просто в браузері, українською 🇺🇦
>
> Як Zwift, але без підписки й без встановлення:
> • смарт-тренажери (Wahoo, Tacx, Elite…), пульсометри, контролери Zwift Ride / Play / Click
> • тренування в ERG, імпорт .zwo, план з intervals.icu
> • гонки з ботами, групові заїзди з друзями, ліги й рейтинг областей
> • челендж дня й серія днів поспіль
>
> Без тренажера теж можна спробувати — є симулятор.
> Працює в Chrome чи Edge на комп'ютері або Android.
>
> 👉 https://automation-remarks.com/gruppetto/uk/?utm_campaign=tg-chats
>
> Буду радий відгукам: що бракує, що зламалось.

## 2. Адміністратору клубу (особисте повідомлення)

> Привіт! Я роблю Gruppetto — безкоштовний віртуальний велотренажер у браузері, українською. Є групові заїзди й гонки наживо, ліги з таблицею очок і рейтинг по областях.
>
> Хочу запропонувати вашому клубу спробувати зимовий сезон у ньому:
> • своя ліга клубу з таблицею;
> • щотижневий клубний заїзд чи гонка у фіксований час (наприклад, вівторок 19:00), посилання одне на всіх;
> • усе безкоштовно, без підписок; заїзди вивантажуються в intervals.icu або як .FIT.
>
> Налаштую лігу й перший заїзд сам, від вас — тільки кинути посилання в чат клубу. Якщо щось не працюватиме з вашими тренажерами — виправлю швидко.
>
> Ось як це виглядає: [відео]
> https://automation-remarks.com/gruppetto/uk/?utm_campaign=tg-clubs

## 3. Facebook-група (довше, з відео або стоп-кадром)

> Зима, тренажер, а за Zwift щомісяця платити підписку? Я зробив Gruppetto: віртуальний велотренажер просто в браузері. Безкоштовно, українською, нічого не треба встановлювати.
>
> Що вміє:
> 🚴 смарт-тренажери з FTMS (Wahoo, Tacx, Elite, Saris…) і старі KICKR, пульсометри, датчики каденсу, контролери Zwift Ride / Play / Click
> 🎯 тренування в ERG: бібліотека готових, свої в конструкторі, файли .zwo, план з intervals.icu
> 🏁 гонки з ботами твого рівня, групові заїзди й гонки з друзями наживо, ліги
> 🇺🇦 таблиці на підйомах і спринтах, рейтинг областей — хто накрутить більше: Київщина чи Черкащина?
> 👻 виклик другу посиланням: він їде проти твого привида
> 📈 історія, криві потужності, форма й втома, експорт .FIT
>
> Без тренажера — симулятор, щоб подивитися.
> Потрібен Chrome або Edge на комп'ютері чи Android (iPhone не дає браузеру Bluetooth).
>
> https://automation-remarks.com/gruppetto/uk/?utm_campaign=fb-groups
>
> Проєкт робить одна людина, тож кожен відгук справді читаю.

## 4. Підпис для Reels, Shorts, TikTok, Stories (відео 9:16)

> Безкоштовний Zwift у браузері? Gruppetto 🇺🇦
> Тренажер, гонки, групові заїзди — без підписки.
> Посилання в профілі / у сторіз.

Посилання в профіль чи сторіз: `…/uk/?utm_campaign=instagram`.

## 5. Reddit, r/indoorcycling (англійською, історія розробника)

Заголовок: **I built a free indoor cycling app that runs in the browser — smart trainers, ERG workouts, races, group rides**

> I'm a developer and a cyclist from Ukraine. Last winter I got tired of paying for a subscription just to ride my trainer, so I built Gruppetto: it runs in Chrome or Edge, with nothing to install and no account needed.
>
> - Web Bluetooth: FTMS trainers, older Wahoo KICKR (own protocol), power meters, HR straps, Zwift Ride / Play / Click controllers, OpenBikeControl
> - ERG workouts, a workout builder, .zwo import, and your intervals.icu plan synced both ways
> - races against bots at your level, live group rides with friends, leagues
> - ghosts of your best ride, or a friend's ride sent as a link
> - .FIT export (virtual ride, 1 Hz), and it works offline after the first load
>
> It's free; the core ride will stay free. I'd love feedback from people with different trainers: what doesn't connect or feels off?
>
> https://automation-remarks.com/gruppetto/?utm_campaign=reddit

Перед публікацією перечитай правила сабреддіта про самопіар. Відповідай на коментарі в першу годину.

## 6. Форум intervals.icu (розділ для сторонніх застосунків)

> **Gruppetto — free browser trainer app that syncs with intervals.icu**
>
> Your planned rides for the next 7 days show up in the app; ride them in ERG (ramps, ranges, zones, repeats from workout_doc), and the FIT goes back paired with the event, so the workout is marked done. Power curve and fitness come from intervals.icu too, so history from Zwift is there from day one.
>
> Runs in Chrome/Edge, Web Bluetooth (FTMS, older KICKR, Zwift Ride controllers). Free, no account needed.
>
> https://automation-remarks.com/gruppetto/?utm_campaign=intervals-forum

---

## Як публікувати

- Перед постом спитай адміна чату, чи можна. Пост без дозволу видаляють, а автора банять.
- Не більше 2–3 чатів на день, і текст щоразу трохи інший. Однаковий пост у десяти чатах Telegram вважає спамом.
- Найкращий час — вечір вівторка–четверга, коли люди сидять на тренажері.
- Відповідай на кожне питання в першу годину: від цього залежить, скільки людей спробують.
- Через тиждень глянь GoatCounter: Campaigns, потім `ride-start` і `ride-finish`. Вкладайся далі в канал, де найбільше заїздів, а не переглядів.
