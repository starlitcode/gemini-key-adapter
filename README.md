# Gemini Key Adapter

A tiny local helper for apps that speak Google's Gemini API, when your Gemini-compatible gateway doesn't accept the key the way Google does.

Google's Gemini API reads the API key from the URL (`?key=`) or the `x-goog-api-key` header. Some gateways, LiteRouter for example, only read `Authorization: Bearer`, and also have no `GET /v1beta/models`. Apps that follow Google's format then get:

- `401 Invalid or missing API key` when chatting, even with a valid key
- a 404 from Test Connection, and an empty model list

The adapter sits between your app and the gateway, on your own device:

```text
your app  ->  http://127.0.0.1:8790  ->  gateway (https://api.literouter.com)
```

- It moves the key from `?key=` or `x-goog-api-key` into `Authorization: Bearer`, and removes it from the URL.
- It answers `GET /v1beta/models` using the gateway's `/v1/models`, listing only models its Gemini endpoint serves. That makes the model list and connection tests work.
- Everything else passes straight through, including streamed replies. Stopping a reply in your app also stops the request at the gateway.

It listens on `127.0.0.1` only, so nothing outside your device can reach it. Your key is passed on to the gateway and is never written to the log.

This is an independent tool. It is not made by or endorsed by Google, LiteRouter, or any app you use it with.

## Requirements

Node.js 18 or newer. There are no packages to install.

On Android with Termux:

```bash
pkg install nodejs-lts
```

## Run it

```bash
node gemini-adapter.js
```

Leave it running while you chat. Ctrl+C stops it.

Optional settings:

```bash
PORT=8790 UPSTREAM=https://api.literouter.com node gemini-adapter.js
```

## Set up your app

In your app's Gemini (Google AI Studio) connection:

| Setting | Value |
| --- | --- |
| Provider | Google Gemini |
| API URL | `http://127.0.0.1:8790` |
| API key | your gateway key |
| Model | a Gemini model id from the gateway, such as `gemini-3-flash-preview:payg` |

The app and the adapter have to run on the same device.

## Android tips

- Android can close Termux in the background. Run `termux-wake-lock` once per session, or turn off battery optimization for Termux, to keep the adapter alive.
- To start it faster, add an alias to `~/.bashrc`: `alias gka='node ~/gemini-adapter.js'`

## License

MIT
