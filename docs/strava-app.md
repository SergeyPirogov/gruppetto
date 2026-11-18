# Strava: Gruppetto's own app and the review

Uploading to Strava has been built since #32: connect in Profile → Connections, and a finished ride goes up as a Virtual Ride. Two things keep it hidden for most riders (`?strava=1` shows it):

- It still uses Slipstream's Strava app (client id `167103`) and Slipstream's token function on Vercel.
- A Strava app that has not passed review has an **athlete capacity of 1**: only its owner can connect.

## 1. Register Gruppetto's own Strava app

At https://www.strava.com/settings/api create an app:

| Field | Value |
| --- | --- |
| Application Name | Gruppetto |
| Category | Training |
| Club | (empty) |
| Website | https://automation-remarks.com/gruppetto/ |
| Application Description | Free indoor cycling in the browser: smart trainers over Bluetooth, real roads, workouts, group rides. Uploads finished rides to Strava. |
| Authorization Callback Domain | automation-remarks.com |
| Icon | `icons/icon-512.png` |

Two values come out of it:

- **Client ID.** This is public. Put it into `OWN_APP_ID` in `js/strava.js`.
- **Client Secret.** This is private. Never put it in the repo or the chat.

## 2. Secrets and the token function

Run in your own terminal. The secret goes straight to Supabase.

```sh
npx supabase secrets set STRAVA_CLIENT_ID=<client id> STRAVA_CLIENT_SECRET=<client secret>
npx supabase functions deploy strava --no-verify-jwt
```

Then set `OWN_APP_ID` in `js/strava.js` and deploy the site.

- `TOKEN_URL` switches by itself to `<SUPABASE_URL>/functions/v1/strava`.
- Riders who linked through Slipstream's app are asked to connect again, because their tokens belong to the other app.

## 3. Apply for the review (athlete capacity)

Strava raises the capacity after a review of the app.

- The form is linked from the app's page on https://www.strava.com/settings/api, and from https://developers.strava.com/docs/getting-started/.
- The brand rules come first: https://developers.strava.com/guidelines/.

Gruppetto already meets them:

- The official "Connect with Strava" button (`icons/strava/connect-with-strava.svg`, from Strava's download).
- "View on Strava" links in Strava orange `#FC5200`, bold and underlined, to every uploaded activity.
- The "Compatible with Strava" logo on the Strava card.
- No Strava logo used as the app's own, and "Strava" is not part of the app's name.

Screenshots to attach:

- the Strava card in Profile → Connections;
- the summary after a ride with "View on Strava";
- the activity as it shows on Strava.

### Text for the form

> **What does your app do?**
> Gruppetto is a free indoor cycling app that runs in the browser. Riders connect a smart trainer, heart rate monitor and controllers over Bluetooth, and ride real roads in 3D, structured workouts, or group rides with friends.
>
> **How do you use the Strava API?**
> We use it only to upload. After a ride, the rider's FIT file is sent to `POST /uploads` as a Virtual Ride with power, heart rate, cadence and the route. We then show a "View on Strava" link to the new activity. The scopes are `read,read_all,activity:write`: `read` to show "Connected as <name>", `read_all` to list the rider's own routes (private ones too) and export one as GPX to ride it indoors, and `activity:write` to upload. We read no activities, segments or other athletes' data.
>
> **Where is data stored?**
> The access and refresh tokens stay in the rider's own browser (localStorage). Our server, a Supabase Edge Function, only exchanges the code for tokens and refreshes them using the client secret. It keeps and logs nothing. Disconnecting deletes the tokens from the browser.
>
> **How many athletes?**
> An open beta for Ukrainian and international riders: a few hundred now, expected to grow to a few thousand.
>
> **Website and privacy:** https://automation-remarks.com/gruppetto/ · https://automation-remarks.com/gruppetto/privacy.html

## 4. After approval

Remove the `?strava=1` gate in `stravaShown()` (`js/app.js`), so the Strava card shows to everyone.
