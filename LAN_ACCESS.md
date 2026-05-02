# LAN Access

Use these settings when opening Anki Card Studio from a phone on the same trusted Wi-Fi network.

## URLs

Current Mac LAN IP:

```text
192.168.31.106
```

Open the Studio from the phone:

```text
http://192.168.31.106:8000
```

Open the Symphony dashboard from the phone, when started with `--host 0.0.0.0`:

```text
http://192.168.31.106:8787
```

## Start Commands

Recommended Studio LAN server:

```bash
cd /Users/pedan/Desktop/file
node scripts/lan-server.mjs
```

Open this URL from the phone so AnkiConnect is proxied through the same
origin as the page:

```text
http://192.168.31.106:8000/?ankiProxy=1&bridgeProxy=1
```

Fallback static server, without AnkiConnect/OmniFocus proxy:

```bash
cd /Users/pedan/Desktop/file
python3 -m http.server 8000 --bind 0.0.0.0
```

OmniFocus bridge for phone-triggered task sync:

```bash
cd /Users/pedan/Desktop/file
OMNIFOCUS_BRIDGE_HOST=0.0.0.0 node scripts/omnifocus-bridge.mjs
```

Symphony dashboard:

```bash
cd /Users/pedan/Desktop/file
npm run symphony -- start --workflow WORKFLOW.md --port 8787 --host 0.0.0.0
```

## AnkiConnect

AnkiConnect must listen on the LAN and allow this site origin:

```json
{
  "webBindAddress": "0.0.0.0",
  "webBindPort": 8765,
  "webCorsOriginList": [
    "http://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8000",
    "http://192.168.31.106:8000"
  ]
}
```

After changing the AnkiConnect add-on config, restart Anki.

## Security

Only use this on trusted Wi-Fi. AnkiConnect and the OmniFocus bridge are local automation endpoints.
