/* The browser Maps key is injected here at deploy time from the
   GOOGLE_MAPS_BROWSER_KEY repo secret (see .github/workflows/deploy.yml).

   A browser key is necessarily public — restrict it in the Google Cloud
   console to the HTTP referrer https://athzbd.github.io/* and set a daily
   quota cap so it can never run up a bill.

   Left as the placeholder locally; the page just hides the map. */
window.LDNRECS = { mapsKey: '__GOOGLE_MAPS_BROWSER_KEY__' };
