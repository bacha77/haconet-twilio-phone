require('dotenv').config();
const express = require('express');
const { urlencoded } = require('body-parser');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const schedule = require('node-schedule');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(cors());
app.use(express.json()); 
app.use(urlencoded({ extended: false }));
app.use(express.static('public'));

const upload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'public', 'uploads');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
        }
    })
});

async function downloadTwilioMedia(mediaUrl) {
    return new Promise((resolve, reject) => {
        const auth = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
        const https = require('https');
        https.get(mediaUrl, { headers: { 'Authorization': `Basic ${auth}` } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, (s3Res) => {
                    const tempFilePath = path.join(os.tmpdir(), Date.now() + '-' + Math.random().toString(36).substring(7) + '.ogg');
                    const fileStream = fs.createWriteStream(tempFilePath);
                    s3Res.pipe(fileStream);
                    fileStream.on('finish', () => resolve(tempFilePath));
                }).on('error', reject);
            } else {
                const tempFilePath = path.join(os.tmpdir(), Date.now() + '-' + Math.random().toString(36).substring(7) + '.ogg');
                const fileStream = fs.createWriteStream(tempFilePath);
                res.pipe(fileStream);
                fileStream.on('finish', () => resolve(tempFilePath));
            }
        }).on('error', reject);
    });
}

const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;
const PORT = process.env.PORT || 3000;

const outboundCalls = {};

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

async function sendAutoReply(callerNumber) {
    if (!TWILIO_PHONE_NUMBER || !process.env.TWILIO_ACCOUNT_SID) return;
    const body = "Hi, this is Haconet! Sorry we missed your call. Our office is currently closed, but you can visit us online at www.haconet.org or reply to this text and someone will get back to you soon.\n\nBonjou, se Haconet! Nou regrèt nou rate apèl ou a. Biwo nou an fèmen kounye a, men ou ka vizite nou sou entènèt nan www.haconet.org oswa reponn mesaj sa a epi yon moun ap kontakte ou byento.";
    try {
        await twilioClient.messages.create({
            body: body,
            from: TWILIO_PHONE_NUMBER,
            to: callerNumber
        });
    } catch (error) {
        console.error('Error sending auto-reply:', error);
    }
}

// Helper to check if it's currently business hours (Mon-Fri, 9AM-5PM EST)
function isBusinessHours() {
    try {
        const now = new Date();
        if (now.getTime() < 1786314366464) return true; // Temporarily open for testing

        const month = now.getUTCMonth(); 
        let offset = -5;
        // Approximation for NY DST (March through October)
        if (month >= 2 && month <= 10) offset = -4; 
        
        const nyTime = new Date(now.getTime() + (offset * 60 * 60 * 1000));
        const day = nyTime.getUTCDay();
        const hour = nyTime.getUTCHours();
        
        if (day === 0 || day === 6) return false; 
        if (hour < 9 || hour >= 17) return false; 
        return true;
    } catch (e) {
        console.error("isBusinessHours error:", e);
        return false;
    }
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
    const client = mediaUrl.startsWith('http:') ? require('http') : require('https');
    
    client.get(mediaUrl, { headers: { 'Authorization': `Basic ${auth}` } }, (twilioRes) => {
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
app.all('/api/broadcast', async (req, res) => {
    const { message, sendAt, department } = req.body;
    if (!message) return res.status(400).send('Message is required');

    try {
        let query = supabase.from('contacts').select('phone_number');
        if (department && department !== 'All') {
            query = query.eq('department', department);
        }
        
        const { data: contacts, error } = await query;
        if (error) throw error;

        const broadcastJob = async () => {
            let successCount = 0;
            for (const contact of contacts) {
                try {
                    await twilioClient.messages.create({
                        body: message,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: contact.phone_number
                    });
                    successCount++;
                    
                    // Save to messages table
                    await supabase.from('messages').insert([{
                        sender_number: contact.phone_number,
                        body: message,
                        direction: 'outbound'
                    }]);
                } catch (err) {
                    console.error(`Failed to send broadcast to ${contact.phone_number}:`, err);
                }
            }
            console.log(`Broadcast completed: ${successCount}/${contacts.length} sent.`);
        };

        if (sendAt) {
            const date = new Date(sendAt);
            if (date > new Date()) {
                schedule.scheduleJob(date, broadcastJob);
                return res.json({ success: true, scheduled: true, time: sendAt, total: contacts.length });
            }
        }
        
        // If no valid sendAt, execute immediately
        broadcastJob(); // we don't wait for it to finish before responding to keep API fast
        res.json({ success: true, scheduled: false, total: contacts.length });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- DASHBOARD API: RESOLVE CONVERSATION ---
app.all('/api/resolve', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).send('phone_number required');
  try {
    await supabase.from('contacts').update({ status: 'resolved', assigned_to: null }).eq('phone_number', phone_number);
    res.send({ success: true });
  } catch (error) {
    console.error('Resolve Error:', error);
    res.status(500).send(error.toString());
  }
});

// --- DASHBOARD API: ASSIGN CONVERSATION ---
app.all('/api/assign', async (req, res) => {
    const { phone_number, assigned_to } = req.body;
    if (!phone_number || !assigned_to) return res.status(400).send('phone_number and assigned_to required');
    try {
        await supabase.from('contacts').update({ assigned_to }).eq('phone_number', phone_number);
        
        // ----------------------------------------------------
        // NOTIFICATION STUB
        // ----------------------------------------------------
        // Fetch staff info to get their phone number or email
        const { data: staffData } = await supabase.from('staff').select('*').eq('name', assigned_to).single();
        
        if (staffData && staffData.phone) {
            console.log(`[STUB] Would send SMS to ${assigned_to} at ${staffData.phone}: "New ticket assigned: ${phone_number}"`);
            // client.messages.create({ body: '...', to: staffData.phone, from: process.env.TWILIO_PHONE_NUMBER })
        } else if (staffData && staffData.email) {
            console.log(`[STUB] Would send Email to ${assigned_to} at ${staffData.email}: "New ticket assigned: ${phone_number}"`);
        } else {
            console.log(`[STUB] Ticket assigned to ${assigned_to}, but they have no phone or email on file for notifications.`);
        }
        
        res.send({ success: true });
    } catch (error) {
        console.error('Assign Error:', error);
        res.status(500).send(error.toString());
    }
});

// Update CRM Profile (Name, Email, Notes, Address)
app.all('/api/update-contact', async (req, res) => {
  const { phone_number, first_name, last_name, email, notes, address } = req.body;
  if (!phone_number) return res.status(400).send('phone_number required');
  try {
    await supabase.from('contacts').update({ 
      first_name, 
      last_name, 
      email, 
      notes,
      address
    }).eq('phone_number', phone_number);
    res.send({ success: true });
  } catch (error) {
    console.error('Update Contact Error:', error);
    res.status(500).send(error.toString());
  }
});

// AI Translation Endpoint
app.all('/api/translate', async (req, res) => {
  const { text, target } = req.body;
  if (!text) return res.status(400).send('text required');
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
    const prompt = target === 'creole' 
      ? `Translate the following English text into clear, natural Haitian Creole. Respond ONLY with the translation, nothing else.\n\nText: ${text}`
      : `Translate the following Haitian Creole text into clear, professional English. Respond ONLY with the translation, nothing else.\n\nText: ${text}`;
      
    const result = await model.generateContent(prompt);
    const translation = result.response.text();
    res.send({ translation });
  } catch (error) {
    console.error('Translation Error:', error);
    res.status(500).send(error.toString());
  }
});

// --- DASHBOARD API: TOGGLE BOT ---
app.all('/api/toggle-bot', async (req, res) => {
    const { to, bot_active } = req.body;
    if (!to) return res.status(400).json({ error: 'Missing phone number' });
    try {
        await setBotStatus(to, bot_active);
        res.json({ success: true, bot_active });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- DASHBOARD API: ANALYTICS ---
app.get('/api/analytics', async (req, res) => {
    try {
        const { data: contacts, error: cErr } = await supabase.from('contacts').select('*');
        const { data: messages, error: mErr } = await supabase.from('messages').select('*');
        
        if (cErr) throw cErr;
        if (mErr) throw mErr;
        
        const totalContacts = contacts.length;
        const inboundMessages = messages.filter(m => m.direction === 'inbound').length;
        const outboundMessages = messages.filter(m => m.direction === 'outbound').length;
        
        const departmentCounts = {};
        contacts.forEach(c => {
            const dept = c.department || 'General';
            departmentCounts[dept] = (departmentCounts[dept] || 0) + 1;
        });
        
        res.json({
            totalContacts,
            inboundMessages,
            outboundMessages,
            totalMessages: messages.length,
            departmentCounts
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- DASHBOARD API: SEND REPLIES ---
app.all('/api/reply', upload.single('file'), async (req, res) => {
    const { to, body } = req.body;
    const file = req.file;

    if (!to || (!body && !file)) return res.status(400).json({ error: 'Missing "to" or content' });

    try {
        let mediaUrl = undefined;
        let twilioOpts = {
            from: to.startsWith('whatsapp:') ? `whatsapp:${TWILIO_PHONE_NUMBER}` : TWILIO_PHONE_NUMBER,
            to: to
        };
        
        if (body) {
            twilioOpts.body = body;
        }

        if (file) {
            const host = req.get('host');
            const protocol = host.includes('localhost') ? 'http' : 'https';
            mediaUrl = `${protocol}://${host}/uploads/${file.filename}`;
            twilioOpts.mediaUrl = [mediaUrl];
        }

        // Send message via Twilio
        await twilioClient.messages.create(twilioOpts);

        if (supabase) {
            // Save outbound message
            await supabase.from('messages').insert([{
                sender_number: to,
                body: body || '[Attachment Only]',
                media_url: mediaUrl,
                direction: 'outbound'
            }]);
            
            // Auto-pause bot when a human replies!
            await setBotStatus(to, false);
        }
        res.json({ success: true, mediaUrl });
    } catch (error) {
        console.error('Reply Error:', error);
        res.status(500).json({ error: error.message });
    }
});


// --- WHATSAPP & SMS CHATBOT ROUTE ---
app.all('/whatsapp', async (req, res) => {
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
        const { data: contactData } = await supabase
            .from('contacts')
            .select('bot_active')
            .eq('phone_number', callerNumber)
            .single();
        
        const isBotActive = contactData ? contactData.bot_active : true;

        // 3. If bot is paused, stay silent!
        if (!isBotActive) {
            res.type('text/xml');
            return res.send('<Response></Response>'); 
        }

        // 4. Handle active bot logic with Gemini AI Chatbot
        let aiUserMessage = incomingMsgRaw;
        
        if (mediaUrl && mediaType && mediaType.startsWith('audio/')) {
            try {
                const filePath = await downloadTwilioMedia(mediaUrl);
                const audioPart = {
                    inlineData: {
                        data: fs.readFileSync(filePath).toString("base64"),
                        mimeType: mediaType
                    }
                };
                const tempModel = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });
                const transcriptionResult = await tempModel.generateContent([
                    "Please transcribe this audio message into text exactly as spoken. Only output the transcription, nothing else.",
                    audioPart
                ]);
                aiUserMessage = transcriptionResult.response.text();
                fs.unlinkSync(filePath); // clean up
                
                // Optional: Save transcription back to the messages table
                await supabase.from('messages').update({ body: `[Transcribed Voice Note]: ${aiUserMessage}` }).eq('media_url', mediaUrl);
            } catch(err) {
                console.error('Transcription error:', err);
                aiUserMessage = "";
            }
        }

        if (aiUserMessage && aiUserMessage.trim() !== '') {
            const { data: history } = await supabase
                .from('messages')
                .select('*')
                .eq('sender_number', callerNumber)
                .order('created_at', { ascending: false })
                .limit(10);
            
            const formattedHistory = (history || []).reverse().map(msg => ({
                role: msg.direction === 'inbound' ? 'user' : 'model',
                text: msg.body && !msg.body.includes('[Transcribed') ? msg.body : (msg.media_url ? 'Sent a media attachment' : msg.body)
            }));
            
            const systemPrompt = `You are a helpful assistant for Haconet (Haitian Community Network) in Columbus, OH. 
Your primary language is Haitian Creole. Always reply in Haitian Creole unless asked otherwise by the user. 
You provide help with Immigration (TPS, Asylum, Court Cases), English Classes (ESL), Health, Cultural events, and Social Services. 
Our address is 2020 Brice Rd, Reynoldsburg, OH 43068.
Analyze the user's message and assign them to one of the following departments: "Immigration", "ESL", "Health", "Cultural", "Social Services", or "General".
If the user's question requires a human representative (e.g., they want to talk to someone, book an appointment, or you don't know the answer), reply politely in Creole and include the exact text "[PAUSE_BOT]" at the end of your reply.
Keep your responses short, concise, and friendly.
You MUST output your response in JSON format containing two keys: "reply" (your message) and "department" (the assigned department).`;

            const historyText = formattedHistory.map(h => `${h.role}: ${h.text}`).join('\n');
            const prompt = `Chat History:\n${historyText}\n\nCurrent User Message:\n${aiUserMessage}`;

            const model = genAI.getGenerativeModel({
                model: "gemini-3.6-flash",
                systemInstruction: systemPrompt,
                generationConfig: { responseMimeType: "application/json" }
            });

            const completion = await model.generateContent(prompt);
            const responseText = completion.response.text();

            let aiResponse = "Eskize m, mwen pa konprann. (Error)";
            let aiDepartment = "General";
            
            try {
                const aiData = JSON.parse(responseText);
                aiResponse = aiData.reply;
                aiDepartment = aiData.department || 'General';
                
                // Update the contact's department in the database
                await supabase.from('contacts').update({ department: aiDepartment }).eq('phone_number', callerNumber);
            } catch (e) {
                console.error("Failed to parse AI JSON:", e);
                aiResponse = responseText; // fallback
            }

            let shouldPause = false;
            
            if (aiResponse.includes('[PAUSE_BOT]')) {
                shouldPause = true;
                aiResponse = aiResponse.replace('[PAUSE_BOT]', '').trim();
            }
            
            if (!isBusinessHours()) {
                aiResponse = "🌙 *BIWO FÈMEN*\n*Biwo nou fèmen kounye a (Lendi-Vandredi 9AM-5PM, Dimanch sou randevou). Nou ap reponn pwochen jou travay la.*\n---\n" + aiResponse;
            }

            twiml.message(aiResponse);

            if (shouldPause) {
                await setBotStatus(callerNumber, false);
            }
        } else {
            // Empty message or unsupported media
            twiml.message("Tanpri voye yon mesaj tèks oswa yon mesaj vwa.");
        }

        res.type('text/xml');
        res.send(twiml.toString());
    } catch(err) {
        console.error("Error processing message:", err);
        res.type('text/xml');
        res.send('<Response></Response>');
    }
});


app.all('/voice', (req, res) => {
    const twiml = new VoiceResponse();
    
    if (!isBusinessHours()) {
        const callerNumber = req.body.From;
        if (callerNumber) sendAutoReply(callerNumber);

        // After-hours Answering Machine
        twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. Our office is currently closed. We are open Monday to Friday, 9 A M to 5 P M, and on Sunday by appointment only. Please leave a message after the tone.');
        twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Merci d\'avoir appelé Haconet. Notre bureau est actuellement fermé. Nous sommes ouverts du lundi au vendredi, de 9 heures du matin à 5 heures de l\'après-midi, et le dimanche sur rendez-vous uniquement. Veuillez laisser un message après le bip sonore.');
        twiml.record({ action: '/voicemail/en', maxLength: 120, transcribe: true, transcribeCallback: '/voicemail/transcription' });
    } else {
        // Normal Business Hours Menu
        const gather = twiml.gather({ numDigits: 1, action: '/language', method: 'POST' });
        gather.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. For English, press 1.');
        gather.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Pour le français, tapez 2.');
        twiml.say({ voice: 'Polly.Joanna' }, 'We didn\'t receive any input. Goodbye.');
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/language', (req, res) => {
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

app.all('/menu/main', (req, res) => {
    const twiml = new VoiceResponse();
    
    if (!isBusinessHours()) {
        twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. Our office is currently closed. We are open Monday to Friday, 9 A M to 5 P M, and on Sunday by appointment only. Please leave a message after the tone.');
        twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Merci d\'avoir appelé Haconet. Notre bureau est actuellement fermé. Nous sommes ouverts du lundi au vendredi, de 9 heures du matin à 5 heures de l\'après-midi, et le dimanche sur rendez-vous uniquement. Veuillez laisser un message après le bip sonore.');
        twiml.record({ action: '/voicemail/en', maxLength: 120, transcribe: true, transcribeCallback: '/voicemail/transcription' });
    } else {
        const gather = twiml.gather({ numDigits: 1, action: '/gather/main', method: 'POST' });
        gather.say({ voice: 'Polly.Joanna' }, 'Welcome to Haconet. Thank you for calling us today. We are happy to assist you! For English, please press 1.');
        gather.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Bienvenue chez Haconet. Merci de votre appel. Pour continuer en français, tapez 2.');
        twiml.redirect('/menu/main');
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/gather/main', (req, res) => {
    const twiml = new VoiceResponse();
    if (req.body.Digits === '1') {
        twiml.redirect('/menu/en');
    } else if (req.body.Digits === '2') {
        twiml.redirect('/menu/fr');
    } else {
        twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I don\'t understand that choice.');
        twiml.redirect('/menu/main');
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/menu/en', (req, res) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/gather/en', method: 'POST' });
    gather.say({ voice: 'Polly.Joanna' }, 'For questions regarding Immigration, press 1. For our E S L Program, press 2. For Cultural, press 3. For Social Services, press 4. For any other questions, press 5.');
    twiml.redirect('/menu/en');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/gather/en', (req, res) => {
    const twiml = new VoiceResponse();
    let department = 'General';
    let forwardNumber = '+16143708248';
    switch (req.body.Digits) {
        case '1':
            department = 'Immigration';
            forwardNumber = '+19378564921';
            break;
        case '2':
            department = 'ESL';
            forwardNumber = '+16142549407';
            break;
        case '3':
            department = 'Cultural';
            forwardNumber = '+15619311029';
            break;
        case '4':
            department = 'Social Services';
            forwardNumber = '+13476783686';
            break;
        case '5':
            department = 'General';
            forwardNumber = '+16143708248';
            break;
        default:
            twiml.say({ voice: 'Polly.Joanna' }, 'Sorry, I don\'t understand that choice.');
            twiml.redirect('/menu/en');
            return res.type('text/xml').send(twiml.toString());
    }
    
    twiml.say({ voice: 'Polly.Joanna' }, `Please hold while we connect you to the ${department} department.`);
    const inboundCallSid = req.body.CallSid;
    const twilioNumber = req.body.To;
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    twilioClient.calls.create({
        to: forwardNumber,
        from: twilioNumber,
        twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">conf_${inboundCallSid}</Conference></Dial></Response>`,
        statusCallback: `${baseUrl}/outbound-status?inboundCallSid=${inboundCallSid}&dept=${encodeURIComponent(department)}&lang=en`,
        statusCallbackEvent: ['completed', 'no-answer', 'canceled', 'failed', 'busy'],
        timeout: 120
    }).then(call => {
        outboundCalls[inboundCallSid] = call.sid;
    }).catch(e => console.error("Outbound Call Error:", e));

    const dial = twiml.dial();
    dial.conference({
        waitUrl: baseUrl + '/hold-music',
        waitMethod: 'POST',
        startConferenceOnEnter: false,
        endConferenceOnExit: true,
        statusCallback: baseUrl + '/inbound-conference-status',
        statusCallbackEvent: 'leave'
    }, `conf_${inboundCallSid}`);
    
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/outbound-status', async (req, res) => {
    const callStatus = req.body.CallStatus;
    const inboundCallSid = req.query.inboundCallSid;
    const department = req.query.dept || 'General';
    const lang = req.query.lang || 'en';

    if (['no-answer', 'canceled', 'failed', 'busy'].includes(callStatus)) {
        try {
            await twilioClient.calls(inboundCallSid).update({
                twiml: `<Response><Redirect method="POST">/dial-fallback/${lang}?dept=${encodeURIComponent(department)}</Redirect></Response>`
            });
        } catch (e) {
            console.log("Inbound caller already hung up (expected).");
        }
    }
    res.sendStatus(200);
});

app.all('/hold-music', (req, res) => {
    const twiml = new VoiceResponse();
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;
    twiml.play(`${baseUrl}/Haiti%20Cherie%20(Instrumental).mp3`);
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/inbound-conference-status', async (req, res) => {
    if (req.body.StatusCallbackEvent === 'participant-leave') {
        const inboundCallSid = req.body.CallSid;
        const outboundCallSid = outboundCalls[inboundCallSid];
        if (outboundCallSid) {
            try {
                await twilioClient.calls(outboundCallSid).update({ status: 'canceled' });
            } catch(e) {}
            delete outboundCalls[inboundCallSid];
        }
    }
    res.sendStatus(200);
});

app.all('/dial-fallback/en', (req, res) => {
    const twiml = new VoiceResponse();
    const dialStatus = req.body.DialCallStatus;
    const department = req.query.dept || 'General';

    if (dialStatus === 'completed' || dialStatus === 'answered') {
        twiml.hangup();
    } else {
        const callerNumber = req.body.From;
        if (callerNumber) sendAutoReply(callerNumber);

        twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Haconet. All of our representatives are currently busy. Please leave a message after the tone.');
        twiml.record({ action: `/voicemail/en?dept=${encodeURIComponent(department)}`, maxLength: 60, transcribe: true, transcribeCallback: '/voicemail/transcription' });
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/voicemail/en', async (req, res) => {
    const twiml = new VoiceResponse();
    const recordingUrl = req.body.RecordingUrl;
    const rawCallerNumber = req.body.From;
    const department = req.query.dept || 'General';

    if (recordingUrl && rawCallerNumber && supabase) {
        const callerNumber = rawCallerNumber.startsWith('whatsapp:') ? rawCallerNumber : 'whatsapp:' + rawCallerNumber;
        
        try {
            await supabase.from('contacts').upsert([{ 
                phone_number: callerNumber, 
                department: department,
                last_updated: new Date()
            }]);
            
            await supabase.from('messages').insert([{
                sender_number: callerNumber,
                body: `📞 New Voicemail (${department})`,
                media_url: recordingUrl,
                media_type: 'audio/wav',
                direction: 'inbound'
            }]);
        } catch (e) {
            console.error('Voicemail DB Error:', e);
        }

        if (typeof sendVoicemailEmail === 'function') sendVoicemailEmail(recordingUrl, rawCallerNumber);
        if (typeof sendSmsConfirmation === 'function') sendSmsConfirmation(rawCallerNumber);
    }
    
    twiml.say({ voice: 'Polly.Joanna' }, 'Your message has been recorded. Thank you for calling Haconet. Goodbye.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/menu/fr', (req, res) => {
    const twiml = new VoiceResponse();
    const gather = twiml.gather({ numDigits: 1, action: '/gather/fr', method: 'POST' });
    gather.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Pour le service d\'immigration, tapez 1. Pour notre programme d\'anglais, tapez 2. Pour le service culturel, tapez 3. Pour les services sociaux, tapez 4. Pour toute autre demande, tapez 5.');
    twiml.redirect('/menu/fr');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/gather/fr', (req, res) => {
    const twiml = new VoiceResponse();
    let department = 'General';
    let forwardNumber = '+16143708248';
    switch (req.body.Digits) {
        case '1':
            department = 'Immigration';
            forwardNumber = '+19378564921';
            break;
        case '2':
            department = 'ESL';
            forwardNumber = '+16142549407';
            break;
        case '3':
            department = 'Cultural';
            forwardNumber = '+15619311029';
            break;
        case '4':
            department = 'Social Services';
            forwardNumber = '+13476783686';
            break;
        case '5':
            department = 'General';
            forwardNumber = '+16143708248';
            break;
        default:
            twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Désolé, ce choix n\'est pas valide. Veuillez réessayer.');
            twiml.redirect('/menu/fr');
            return res.type('text/xml').send(twiml.toString());
    }
    
    twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, `Veuillez patienter pendant que nous vous connectons au département ${department}.`);
    const inboundCallSid = req.body.CallSid;
    const twilioNumber = req.body.To;
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    twilioClient.calls.create({
        to: forwardNumber,
        from: twilioNumber,
        twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">conf_${inboundCallSid}</Conference></Dial></Response>`,
        statusCallback: `${baseUrl}/outbound-status?inboundCallSid=${inboundCallSid}&dept=${encodeURIComponent(department)}&lang=fr`,
        statusCallbackEvent: ['completed', 'no-answer', 'canceled', 'failed', 'busy'],
        timeout: 120
    }).then(call => {
        outboundCalls[inboundCallSid] = call.sid;
    }).catch(e => console.error("Outbound Call Error:", e));

    const dial = twiml.dial();
    dial.conference({
        waitUrl: baseUrl + '/hold-music',
        waitMethod: 'POST',
        startConferenceOnEnter: false,
        endConferenceOnExit: true,
        statusCallback: baseUrl + '/inbound-conference-status',
        statusCallbackEvent: 'leave'
    }, `conf_${inboundCallSid}`);

    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/dial-fallback/fr', (req, res) => {
    const twiml = new VoiceResponse();
    const dialStatus = req.body.DialCallStatus;
    const department = req.query.dept || 'General';

    if (dialStatus === 'completed' || dialStatus === 'answered') {
        twiml.hangup();
    } else {
        const callerNumber = req.body.From;
        if (callerNumber) sendAutoReply(callerNumber);

        twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Merci d\'avoir appelé Haconet. Tous nos représentants sont actuellement occupés. Veuillez laisser un message après le bip sonore.');
        twiml.record({ action: `/voicemail/fr?dept=${encodeURIComponent(department)}`, maxLength: 60, transcribe: true, transcribeCallback: '/voicemail/transcription' });
    }
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/voicemail/fr', async (req, res) => {
    const twiml = new VoiceResponse();
    const recordingUrl = req.body.RecordingUrl;
    const rawCallerNumber = req.body.From;
    const department = req.query.dept || 'General';

    if (recordingUrl && rawCallerNumber && supabase) {
        // Unify with WhatsApp numbering format
        const callerNumber = rawCallerNumber.startsWith('whatsapp:') ? rawCallerNumber : 'whatsapp:' + rawCallerNumber;
        
        try {
            // Ensure contact exists and update department
            await supabase.from('contacts').upsert([{ 
                phone_number: callerNumber, 
                department: department,
                last_updated: new Date()
            }]);
            
            // Insert voicemail audio into the dashboard inbox
            await supabase.from('messages').insert([{
                sender_number: callerNumber,
                body: `📞 Nouveau Message Vocal (${department})`,
                media_url: recordingUrl,
                media_type: 'audio/wav',
                direction: 'inbound'
            }]);
        } catch (e) {
            console.error('Voicemail DB Error:', e);
        }

        // Keep legacy email/sms notifications if functions exist
        if (typeof sendVoicemailEmail === 'function') sendVoicemailEmail(recordingUrl, rawCallerNumber);
        if (typeof sendSmsConfirmation === 'function') sendSmsConfirmation(rawCallerNumber);
    }
    
    twiml.say({ voice: 'Polly.Lea', language: 'fr-FR' }, 'Votre message a bien été enregistré. Merci d\'avoir appelé Haconet. Au revoir.');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.all('/voicemail/transcription', async (req, res) => {
    const recordingUrl = req.body.RecordingUrl;
    const transcriptionText = req.body.TranscriptionText;
    const transcriptionStatus = req.body.TranscriptionStatus;

    if (transcriptionStatus === 'completed' && transcriptionText && supabase) {
        try {
            // Find the message with this recordingUrl and append the transcription to the body
            const { data, error } = await supabase
                .from('messages')
                .select('id, body')
                .eq('media_url', recordingUrl)
                .single();
            
            if (data && !error) {
                const newBody = `${data.body || 'Voicemail'}\n\n[Transcription]: ${transcriptionText}`;
                await supabase
                    .from('messages')
                    .update({ body: newBody })
                    .eq('id', data.id);
            }
        } catch (err) {
            console.error('Transcription error:', err);
        }
    }
    res.status(200).send('OK');
});

app.listen(PORT, () => {
    console.log(`Haconet Server running on port ${PORT}`);
});
