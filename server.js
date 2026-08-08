require('dotenv').config();
const express = require('express');
const { urlencoded } = require('body-parser');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

const app = express();
app.use(urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;
const PORT = process.env.PORT || 3000;

// Config variables
const IMMIGRATION_NUMBER = process.env.IMMIGRATION_NUMBER || '+1234567890';
const ESL_NUMBER = process.env.ESL_NUMBER || '+0987654321';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Twilio REST Client (for sending SMS)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Nodemailer Transporter (for sending Emails)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Helper function to send email notification
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

// Helper function to send SMS confirmation
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

// Initial greeting and language selection
app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();
    
    const gather = twiml.gather({
        numDigits: 1,
        action: '/language',
        method: 'POST',
    });
    
    // English
    gather.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. For English, press 1.');
    // French
    gather.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Pour le français, appuyez sur le deux.');
    
    twiml.say({ voice: 'Polly.Joanna' }, 'We didn\'t receive any input. Goodbye.');

    res.type('text/xml');
    res.send(twiml.toString());
});

// Handle Language Selection
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

// --- ENGLISH ROUTE ---
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

// --- FRENCH ROUTE ---
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
