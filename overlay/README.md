# Gruppetto HUD

A see-through panel with the ride's numbers over everything on a Mac: a film, the football, a full-screen video.
Rounded, borderless, always on top, dragged by its body; clicks can pass through it.

Gruppetto (the web page) sends the numbers over a WebSocket on this Mac (127.0.0.1:47629); nothing leaves the computer.

## Use

1. Build it: `overlay/build.sh` → `overlay/Gruppetto HUD.app` (Xcode command line tools; macOS 13+).
2. Open the app: a 🚴 appears in the menu bar (no Dock icon).
3. In Gruppetto: Profile → «Mac overlay» on. Ride with Ride ▾ → «📺 Watch & ride» (the 3D road is not loaded), or any ride.
4. The panel shows while a ride sends numbers and hides 8 s after it stops.

Menu bar 🚴: click through the panel, background (solid … barely there), show (which blocks: heart rate, cadence, the
workout, time · speed · distance, W′bal; power always stays), show it now (to drag it into place), quit.

`GruppettoHUD --snapshot out.png [workout]` draws the panel with sample numbers to a PNG.

## Sharing it

`build.sh` also packs `overlay/Gruppetto-HUD.zip`, with the app's icon (drawn by `icon.swift`). Attach it to a GitHub
release under that name: Profile → «Download Gruppetto HUD for Mac» points at
`releases/latest/download/Gruppetto-HUD.zip`.

The build is signed ad hoc, so on another Mac Gatekeeper stops the first launch: System Settings → Privacy & Security
→ Open Anyway. Without that step it needs a Developer ID signature and notarization (an Apple developer account).
