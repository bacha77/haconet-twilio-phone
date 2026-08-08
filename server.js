require('dotenv').config();
const express = require('express');
const { urlencoded } = require('body-parser');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(urlencoded({ extended: false }));

const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;
const PORT = process.env.PORT || 3000;

// Config variables
const IMMIGRATION_NUMBER = process.env.IMMIGRATION_NUMBER || '+1234567890';
const ESL_NUMBER = process.env.ESL_NUMBER || '+0987654321';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Twilio REST Client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Supabase Client
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
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
    } catch (error) {
        console.error('Error sending SMS:', error);
    }
}

// Helper to check if it's currently business hours (Mon-Fri, 9AM-5PM EST)
function isBusinessHours() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        hour12: false,
        weekday: 'short'
    });
    
    const parts = formatter.formatToParts(now);
    let hour = 0;
    let weekday = '';
    
    for (const part of parts) {
        if (part.type === 'hour') hour = parseInt(part.value, 10);
        if (part.type === 'weekday') weekday = part.value;
    }
    
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    if (hour < 9 || hour >= 17) return false;
    
    return true;
}

// Helper to pause bot for a specific number
async function setBotStatus(phoneNumber, isActive) {
    if (!supabase) return;
    await supabase.from('contacts').upsert([{ 
        phone_number: phoneNumber, 
        bot_active: isActive,
        last_updated: new Date()
    }]);
}

// --- DASHBOARD API: MEDIA PROXY ---
app.get('/api/media', (req, res) => {
    const mediaUrl = req.query.url;
    if (!mediaUrl) return res.status(400).send('Missing url');

    const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const https = require('https');
    
    https.get(mediaUrl, { headers: { 'Authorization': `Basic ${auth}` } }, (twilioRes) => {
        if (twilioRes.statusCode >= 300 && twilioRes.statusCode < 400 && twilioRes.headers.location) {
            res.redirect(twilioRes.headers.location);
        } else {
            res.writeHead(twilioRes.statusCode, twilioRes.headers);
            twilioRes.pipe(res);
        }
    }).on('error', (err) => {
        res.status(500).send(err.message);
    });
});

// --- DASHBOARD API: BROADCAST MESSAGING ---
app.post('/api/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).send('Message is required');

    try {
        // Get all unique contacts
        const { data: contacts, error } = await supabase.from('contacts').select('phone_number');
        if (error) throw error;

        let successCount = 0;
        for (const contact of contacts) {
            try {
                await twilioClient.messages.create({
                    body: message,
                    from: process.env.TWILIO_PHONE_NUMBER,
                    to: contact.phone_number
                });
                successCount++;
                
                // Also save the broadcast to the messages table so it shows in chat history
                await supabase.from('messages').insert([{
                    sender_number: contact.phone_number,
                    body: message,
                    direction: 'outbound'
                }]);
            } catch (err) {
                console.error(`Failed to send broadcast to ${contact.phone_number}:`, err);
            }
        }
        res.json({ success: true, sent: successCount, total: contacts.length });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- DASHBOARD API: RESOLVE CONVERSATION ---
app.post('/api/resolve', async (req, res) => {
    const { phone_number } = req.body;
    try {
        await supabase.from('contacts')
            .update({ status: 'resolved' })
            .eq('phone_number', phone_number);
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- DASHBOARD API: TOGGLE BOT ---
app.post('/api/toggle-bot', async (req, res) => {
    const { to, bot_active } = req.body;
    if (!to) return res.status(400).json({ error: 'Missing phone number' });
    try {
        await setBotStatus(to, bot_active);
        res.json({ success: true, bot_active });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- DASHBOARD API: SEND REPLIES ---
app.post('/api/reply', async (req, res) => {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing "to" or "body"' });

    try {
        // Send message via Twilio
        await twilioClient.messages.create({
            body: body,
            from: to.startsWith('whatsapp:') ? `whatsapp:${TWILIO_PHONE_NUMBER}` : TWILIO_PHONE_NUMBER,
            to: to
        });

        if (supabase) {
            // Save outbound message
            await supabase.from('messages').insert([{
                sender_number: to,
                body: body,
                direction: 'outbound'
            }]);
            
            // Auto-pause bot when a human replies!
            await setBotStatus(to, false);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// --- WHATSAPP & SMS CHATBOT ROUTE ---
app.post('/whatsapp', async (req, res) => {
    const twiml = new MessagingResponse();
    const incomingMsgRaw = req.body.Body || '';
    const incomingMsg = incomingMsgRaw.trim().toLowerCase();
    const callerNumber = req.body.From;
    
    // Extract Media if it exists (Voice Notes, Images)
    const numMedia = parseInt(req.body.NumMedia || '0');
    let mediaUrl = null;
    let mediaType = null;
    if (numMedia > 0) {
        mediaUrl = req.body.MediaUrl0;
        mediaType = req.body.MediaContentType0;
    }

    if (!supabase || !callerNumber) {
        return res.send('<Response></Response>'); // Fail silently if no DB
    }

    try {
        // 1. Save incoming message
        await supabase.from('messages').insert([{
            sender_number: callerNumber,
            body: incomingMsgRaw,
            direction: 'inbound',
            media_url: mediaUrl,
            media_type: mediaType
        }]);

        if (incomingMsg === 'stop') {
            await setBotStatus(callerNumber, true); // re-enable bot if they say stop
        }

        // --- NEW: INBOX MANAGEMENT ---
        // Update the contacts table to mark this person as 'unread' and record the time
        await supabase.from('contacts').upsert(
            { phone_number: callerNumber, status: 'unread', last_message_at: new Date().toISOString() },
            { onConflict: 'phone_number' }
        );

        // 2. Check if Bot is active for this user
        const { data: contact } = await supabase
            .from('contacts')
            .select('bot_active')
            .eq('phone_number', callerNumber)
            .single();
        
        const isBotActive = contact ? contact.bot_active : true;

        // 3. If bot is paused, stay silent! (Send empty response)
        if (!isBotActive) {
            res.type('text/xml');
            return res.send('<Response></Response>'); 
        }

        // 4. Handle active bot logic
        if (incomingMsg === '1') {
            twiml.message(
                "📍 *SÈVIS IMIGRASYON* / Immigration Services / Services d'immigration\n\n" +
                "*Haconet ofri asistans nan plizyè domèn imigrasyon. Tanpri reponn ak lèt ki koresponn lan pou plis enfòmasyon:*\n" +
                "Haconet provides assistance with several immigration topics. Please reply with the letter for more info:\n\n" +
                "1A - *TPS* (Estati Pwoteksyon Tanporè)\n" +
                "1B - *Ka Azil* (Asylum Cases / Cas d'asile)\n" +
                "1C - *Ka Tribinal* (Court Cases / Cas de tribunal)"
            );
        } else if (incomingMsg === '1a') {
            twiml.message("🛂 *TPS:* Pou aplikasyon oswa renouvèlman TPS, tanpri asire ou gen paspò ayisyen ou ak prèv ou abite isit la kontinyèlman. Rele nou pandan lè biwo a louvri pou yon konsiltasyon.\n\nFor TPS applications or renewals, please ensure you have your Haitian passport and proof of continuous residence. Call us during business hours to schedule a consultation.");
        } else if (incomingMsg === '1b') {
            twiml.message("⚖️ *AZIL / Asylum:* Ka azil yo mande yon konsiltasyon an detay. Tanpri rele liy imigrasyon nou an pou pale ak yon espesyalis.\n\nAsylum cases require a detailed consultation. Please call our immigration hotline to speak with a specialist.");
        } else if (incomingMsg === '1c') {
            twiml.message("🏛️ *TRIBINAL / Court Cases:* Si ou gen yon dat tribinal imigrasyon ki ap vini, tanpri kontakte biwo nou imedyatman avèk Avi pou Parèt ou a (Notice to Appear - NTA).\n\nIf you have an upcoming immigration court date, please contact our office immediately with your Notice to Appear (NTA).");
        } else if (incomingMsg === '2') {
            twiml.message(
                "📚 *PWOGRAM ANGLÈ* / ESL Program / Programme d'anglais\n\n" +
                "*Kou anglè nou yo fèt pou moun nan tout nivo! Pou anrejistre, tanpri rele biwo prensipal nou an.*\n\n" +
                "Our English classes are designed for all levels! To enroll, please call our main office."
            );
        } else if (incomingMsg === '3') {
            // AUTOMATIC BOT PAUSE
            await setBotStatus(callerNumber, false);
            twiml.message(
                "❓ *LÒT KESYON* / Other / Autre\n\n" +
                "*Tanpri ekri kesyon ou a, oubyen voye yon mesaj vwa la a, epi yon reprezantan ap reponn ou byen vit.*\n\n" +
                "Please type your question or send a voice note here, and a representative will reply to you shortly."
            );
        } else {
            let greeting = "👋 *BYENVENI NAN HACONET!*\n" + 
                "Welcome to Haconet! / Bienvenue à Haconet!\n\n" +
                "*Tanpri reponn avèk yon nimewo pou kòmanse:*\n" +
                "Please reply with a number to get started:\n\n" +
                "1️⃣ - *Imigrasyon* (Immigration - TPS, Asylum, Court Cases)\n" +
                "2️⃣ - *Kou Anglè* (English Classes - ESL)\n" +
                "3️⃣ - *Lòt Kesyon* (Other Questions / Autres Questions)";
                
            if (!isBusinessHours()) {
                greeting = "🌙 *BIWO FÈMEN* / Office Closed / Bureau Fermé\n" +
                           "*Biwo nou fèmen kounye a (Lendi rive Vandredi, 9è nan maten pou 5è nan aswè). Nou ap reponn ou pwochen jou travay la.*\n\n" +
                           "Our office is currently closed (Mon-Fri 9AM-5PM). We will reply on the next business day.\n\n---\n\n" + greeting;
            }
            twiml.message(greeting);
        }

        res.type('text/xml');
        res.send(twiml.toString());
    } catch(err) {
        console.error("Error processing message:", err);
        res.type('text/xml');
        res.send('<Response></Response>');
    }
});


app.post('/voice', (req, res) => {
    const twiml = new VoiceResponse();
    
    if (!isBusinessHours()) {
        // After-hours Answering Machine
        twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. Our office is currently closed. We are open Monday to Friday, 9 A M to 5 P M. Please leave a message after the tone.');
        twiml.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Merci d\'avoir appelé Haconet. Notre bureau est actuellement fermé. Veuillez laisser un message après le bip sonore.');
        twiml.record({ action: '/voicemail/en', maxLength: 120 });
    } else {
        // Normal Business Hours Menu
        const gather = twiml.gather({ numDigits: 1, action: '/language', method: 'POST' });
        gather.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. For English, press 1.');
        gather.say({ voice: 'Polly.Celine', language: 'fr-FR' }, 'Pour le français, appuyez sur le deux.');
        twiml.say({ voice: 'Polly.Joanna' }, 'We didn\'t receive any input. Goodbye.');
    }
    
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
    console.log(`Haconet Server running on port ${PORT}`);
});
