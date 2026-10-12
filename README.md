# AI Face Swap

A Chrome extension that swaps your face onto any photo on a web page.
Everything runs on your own computer, using [FaceFusion](https://github.com/facefusion/facefusion).

## How it works

1. You upload a face photo in the extension popup.
2. You turn on Select Image and click a photo on any page.
3. The extension sends both pictures to a small local server.
4. The server runs FaceFusion and sends the result back.
5. The photo on the page is replaced with the swapped one.

## What is in this repo

| Folder | What it is |
|---|---|
| `npm-create-plasmo-latest/` | The Chrome extension (Plasmo, React, TypeScript) |
| `server/` | The local server that talks to FaceFusion (Node, Express) |

## Setup

You need Node 18 or newer, and a working FaceFusion install.

**1. Server**

```bash
cd server
npm install
cp .env.example .env
```

Open `.env` and set the path to your FaceFusion folder and its Python. Then:

```bash
npm start
```

**2. Extension**

```bash
cd npm-create-plasmo-latest
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, press "Load unpacked",
and pick `npm-create-plasmo-latest/build/chrome-mv3-prod`.

## Good to know

- The server must be running for swaps to work.
- A swap takes about 30 to 50 seconds on a laptop.
- This is a personal experiment. Only swap faces you have the right to use.
