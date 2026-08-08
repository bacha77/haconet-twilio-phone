require('dotenv').config();
const express = require('express');
const { urlencoded } = require('body-parser');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json()); // For the /api/reply JSON body
app.use(urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;
const PORT = process.env.PORT || 3000;

// Config variables
const IMMIGRATION_NUMBER = process.env.IMMIGRATION_NUMBER || '+1234567890';
const ESL_NUMBER = process.env.ESL_NUMBER || '+0987654321';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Twilio REST Client (for sending SMS/WhatsApp out)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Supabase Client
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log("Supabase connected successfully.");
} else {
    console.warn("WARNING: SUPABASE_URL and SUPABASE_KEY are not set in .env");
}

// Nodemailer Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendVoicemailEmail(recordingUrl, callerNumber) {
    if (!process.env.EMAIL_TO || !process.env.EMAIL_USER) return;
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `New Voicemail from ${callerNumber}`,
        text: `You have received a new voicemail from ${callerNumber}.\n\nListen to it here: ${recordingUrl}`
    };
    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email notification sent for voicemail from ${callerNumber}`);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

async function sendSmsConfirmation(callerNumber) {
    if (!TWILIO_PHONE_NUMBER || !process.env.TWILIO_ACCOUNT_SID) return;
    try {
        await twilioClient.messages.create({
            body: 'Thanks for contacting Haconet! We received your voicemail and will call you back shortly.',
            from: TWILIO_PHONE_NUMBER,
            to: callerNumber
        });
        console.log(`SMS confirmation sent to ${callerNumber}`);
    } catch (error) {
        console.error('Error sending SMS:', error);
    }
}

// --- NEW ROUTE: DASHBOARD SENDING REPLIES ---
app.post('/api/reply', async (req, res) => {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing "to" or "body"' });

    try {
        // Send message via Twilio (supports both WhatsApp and SMS based on the "to" format)
        await twilioClient.messages.create({
            body: body,
            from: to.startsWith('whatsapp:') ? `whatsapp:${TWILIO_PHONE_NUMBER}` : TWILIO_PHONE_NUMBER,
            to: to
        });

        // Save outbound message to Supabase
        if (supabase) {
            await supabase.from('messages').insert([{
                sender_number: to,
                body: body,
                direction: 'outbound'
            }]);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending reply:', error);
        res.status(500).json({ error: error.message });
    }
});


// --- WHATSAPP & SMS CHATBOT ROUTE ---
app.post('/whatsapp', async (req, res) => {
    const twiml = new MessagingResponse();
    const incomingMsgRaw = req.body.Body || '';
    const incomingMsg = incomingMsgRaw.trim().toLowerCase();
    const callerNumber = req.body.From;

    // Save incoming message to Supabase
    if (supabase && callerNumber) {
        try {
            await supabase.from('messages').insert([{
                sender_number: callerNumber,
                body: incomingMsgRaw,
                direction: 'inbound'
            }]);
        } catch(err) {
            console.error("Error saving to Supabase:", err);
        }
    }

    if (incomingMsg === '1') {
        twiml.message(
            "📍 *Immigration Services / Services d'immigration*\n\n" +
            "Haconet provides assistance with several immigration topics. Please reply with the letter for more info:\n\n" +
            "1A - TPS (Temporary Protected Status)\n" +
            "1B - Asylum Cases (Cas d'asile)\n" +
            "1C - Court Cases (Cas de tribunal)"
        );
    } else if (incomingMsg === '1a') {
        twiml.message("🛂 *TPS:* For TPS applications or renewals, please ensure you have your Haitian passport and proof of continuous residence. Call us during business hours to schedule a consultation.");
    } else if (incomingMsg === '1b') {
        twiml.message("⚖️ *Asylum:* Asylum cases require a detailed consultation. Please call our immigration hotline to speak with a specialist.");
    } else if (incomingMsg === '1c') {
        twiml.message("🏛️ *Court Cases:* If you have an upcoming immigration court date, please contact our office immediately with your Notice to Appear (NTA).");
    } else if (incomingMsg === '2') {
        twiml.message(
            "📚 *ESL Program / Programme d'anglais*\n\n" +
            "Our English classes are designed for all levels! We offer Basic, Intermediate, and Advanced classes. To enroll, please call our main office or visit our center."
        );
    } else if (incomingMsg === '3') {
        twiml.message(
            "❓ *Other / Autre*\n\n" +
            "Please type your question here, and a representative will reply to you shortly. You can also email us at info@haconet.org."
        );
    } else {
        twiml.message(
            "👋 Welcome to Haconet! / Bienvenue à Haconet!\n\n" +
            "Please reply with a number to get started:\n\n" +
            "1️⃣ - Immigration (TPS, Asylum, Court Cases)\n" +
            "2️⃣ - English Classes (ESL)\n" +
            "3️⃣ - Other Questions / Autres Questions"
        );
    }

    res.type('text/xml');
    res.send(twiml.toString());
});


app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/language', method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. For English, press 1.');
    gather.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Pour le français, appuyez sur le deux.');
    twiml.say({ voice: 'Polly.Joanna' }, 'We didn\'t receive any input. Goodbye.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/language', (req, res) => {
    const twiml = new VoiceResponse();
    if (req.body.Digits === '1') {
        twiml.redirect('/menu/en');
    } else if (req.body.Digits === '2') {
        twiml.redirect('/menu/fr');
    } else {
        twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I don\'t understand that choice.');
        twiml.redirect('/voice');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/menu/en', (req, res) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/gather/en', method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, 'For questions regarding Immigration, press 1. For our E S L Program, press 2. For any other questions, press 3.');
    twiml.redirect('/menu/en');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/gather/en', (req, res) => {
    const twiml = new VoiceResponse();
    switch (req.body.Digits) {
        case '1':
            twiml.say({ voice: 'Polly.Joanna' }, 'You have reached the Immigration department. Please wait while we connect you to a representative.');
            twiml.dial(IMMIGRATION_NUMBER);
            break;
        case '2':
            twiml.say({ voice: 'Polly.Joanna' }, 'You have reached the E S L Program. Please wait while we connect you to an instructor.');
            twiml.dial(ESL_NUMBER);
            break;
        case '3':
            twiml.say({ voice: 'Polly.Joanna' }, 'For all other questions, please leave a message after the beep.');
            twiml.record({ action: '/voicemail/en', maxLength: 60 });
            break;
        default:
            twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I don\'t understand that choice.');
            twiml.redirect('/menu/en');
            break;
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voicemail/en', (req, res) => {
    const twiml = new VoiceResponse();
    const recordingUrl = req.body.RecordingUrl;
    const callerNumber = req.body.From;
    if (recordingUrl && callerNumber) {
        sendVoicemailEmail(recordingUrl, callerNumber);
        sendSmsConfirmation(callerNumber);
    }
    twiml.say({ voice: 'Polly.Joanna' }, 'Your message has been recorded. Thank you for calling Haconet. Goodbye.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/menu/fr', (req, res) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/gather/fr', method: 'POST' });
    gather.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Pour toute question concernant l\'immigration, appuyez sur le 1. Pour notre programme d\'anglais langue seconde, appuyez sur le 2. Pour toute autre question, appuyez sur le 3.');
    twiml.redirect('/menu/fr');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/gather/fr', (req, res) => {
    const twiml = new VoiceResponse();
    switch (req.body.Digits) {
        case '1':
            twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Vous avez joint le département d\'immigration. Veuillez patienter pendant que nous vous mettons en communication avec un représentant.');
            twiml.dial(IMMIGRATION_NUMBER);
            break;
        case '2':
            twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Vous avez joint le programme d\'anglais langue seconde. Veuillez patienter pendant que nous vous mettons en communication avec un professeur.');
            twiml.dial(ESL_NUMBER);
            break;
        case '3':
            twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Pour toute autre question, veuillez laisser un message après le bip sonore.');
            twiml.record({ action: '/voicemail/fr', maxLength: 60 });
            break;
        default:
            twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Désolé, je ne comprends pas ce choix.');
            twiml.redirect('/menu/fr');
            break;
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/voicemail/fr', (req, res) => {
    const twiml = new VoiceResponse();
    const recordingUrl = req.body.RecordingUrl;
    const callerNumber = req.body.From;
    if (recordingUrl && callerNumber) {
        sendVoicemailEmail(recordingUrl, callerNumber);
        sendSmsConfirmation(callerNumber);
    }
    twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Votre message a été enregistré. Merci d\'avoir appelé Haconet. Au revoir.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.listen(PORT, () => {
    console.log(`Haconet Upgraded Server is running on port ${PORT}`);
});
