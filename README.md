# Leave Now: STIB departure widget

A phone-installable web app (PWA) that shows live STIB metro/tram/bus departures for your stop
and tells you when to leave home: **leave at = arrival − arrive-early buffer − walk time**.

## Favourites
Save several stops/lines (e.g. "Work" via tram 7 at Diamant, "Gym" via metro 1 at Merode), each with its own
walk time. Switch by tapping a chip under the title, swiping left/right on the main screen, or with the ← → keys.
Each chip shows a live "leave in X min" glance. A favourite's live data is reused for 60 s when you switch back,
so flicking between them doesn't eat into the request limit. The arrive-early buffer, line map and API key are shared.

## How it works
- Live data: STIB `rt/WaitingTimes` via the Belgian Mobility open data API (no key needed, CORS-enabled).
- The live feed only holds the **next 2 arrivals per line**, which is often shorter than your walk + buffer.
  Later departures are **estimated** by repeating the gap between those two arrivals. The gap is never
  shorter than a typical headway (metro 4, tram 6, bus 8 min). Estimates are shown with `~` / "est.".
- **Line map** (`linemap.js`): a metro-style strip of your line, from its terminus to your stop. It shows live
  vehicle positions (`rt/VehiclePositions`, last stop passed + metres travelled), with each approaching vehicle
  labelled with its arrival time at your stop, plus STIB disruption notices (`rt/TravellersInformation`).
  Notices touching your stop or your stretch of line come first.
- **Lateness is inferred**, because STIB open data has no timetable deviation:
  - *held*: a vehicle that hasn't moved for ~2 polls away from a terminus (red, pulsing)
  - *gap*: spacing between approaching vehicles far above the line's median (dashed amber track)
  - *bunching*: two vehicles less than a stop apart
  - *long wait*: nearest approaching vehicle much further away than usual
- It refreshes every 60 s while open and stops when hidden. Countdowns update every second.
- Each refresh is 1 request, or 2 with the line map on, plus notices every 10 min and route data cached for 7 days. The anonymous limit is about 100 requests/day (≈ 45 min of the app open with the map). For more, create a free account on the
  [developer portal](https://api-management-opendata-production.developer.azure-api.net/) and paste the key
  in Settings. The key header name is `KEY_HEADER` in `app.js`.

## Privacy & security
- No server, no accounts, no third-party scripts or fonts. The page only talks to the STIB open-data API.
- A Content-Security-Policy (meta tag in `index.html`) blocks anything else from loading.
- Favourites, walk times and the optional API key stay in your browser's local storage on your device.
- Every GitHub Pages project under the same `<user>.github.io` shares that storage, so only publish
  trusted code on the same account.

## Run locally
```
python -m http.server 5178
```
Then open http://localhost:5178.

## Put it on your phone
Installing as an app needs HTTPS, so host the folder somewhere static, e.g.:
- **Netlify Drop**: drag this folder onto https://app.netlify.com/drop
- **GitHub Pages**: push to a repo and enable Pages

Then open the URL on your phone:
- **iPhone (Safari)**: Share → *Add to Home Screen*
- **Android (Chrome)**: ⋮ → *Add to Home screen* / *Install app*
