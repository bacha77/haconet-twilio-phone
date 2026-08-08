# Haconet Call Routing System

A Node.js Express server to handle incoming Twilio calls with a voice menu.

## Setup

1. Make sure Node.js is installed.
2. Run `npm install` in this directory to install dependencies.
3. Copy `.env.example` to `.env` and fill in your details (like the `FORWARDING_NUMBER` which should include the country code, e.g., +15551234567).

## Running Locally

1. Run the server:
   ```bash
   node server.js
   ```
2. The server will start on port 3000 by default.

## Testing with Twilio

To connect this local server to Twilio, you need to expose it to the internet. 

1. Download and install [ngrok](https://ngrok.com/).
2. Run ngrok in a new terminal window:
   ```bash
   ngrok http 3000
   ```
3. Copy the `https://xxxx.ngrok-free.app` Forwarding URL.
4. Go to your Twilio console, navigate to your Phone Number settings.
5. Under "A CALL COMES IN", set the Webhook to `[Your Ngrok URL]/voice` and ensure it is set to `HTTP POST`.
6. Call your Twilio number to test!
